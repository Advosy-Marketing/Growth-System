// =====================================================================
// GoHighLevel (v2) adapter — Roofing (VRZA) & Restoration (Bloque)
// Real calls against https://services.leadconnectorhq.com
//
// Auth: a Private Integration token per sub-account, stored as a Supabase
// secret named GHL_TOKEN_<SERVICE_TYPE> (e.g. GHL_TOKEN_ROOFING).
// Location + calendar IDs come from the service_catalog row.
// =====================================================================

import type {
  AvailabilityProvider, ServiceConfig, Slot, BookingInput, BookingResult,
} from "./providers.ts";
import { admin } from "./db.ts";

const BASE = "https://services.leadconnectorhq.com";
const CAL_VERSION = "2021-04-15";      // calendars endpoints
const CONTACT_VERSION = "2021-07-28";  // contacts endpoints

// GHL rejects a contact upsert outright (422 "email must be an email") if `email`
// is present but blank/malformed. Email is optional in our booking form (name +
// phone OR email), so we only send it when it actually looks like an email —
// otherwise the whole booking dies before the appointment is even attempted.
const isValidEmail = (e?: string): boolean =>
  !!e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

// Token resolution order — a PER-LINE token always wins over the shared one,
// from EITHER store, so moving one service line (e.g. restoration) onto its own
// GHL sub-account is a config-only change: just add GHL_TOKEN_<SERVICE>.
//   1) env   GHL_TOKEN_<SERVICE>   (e.g. GHL_TOKEN_RESTORATION)
//   2) Vault GHL_TOKEN_<SERVICE>   (via the locked-down get_secret() accessor)
//   3) env   GHL_TOKEN             (one token shared across sub-accounts)
//   4) Vault GHL_TOKEN             (shared fallback)
async function tokenFor(serviceType: string): Promise<string> {
  const svc = serviceType.toUpperCase();
  const envPer = Deno.env.get(`GHL_TOKEN_${svc}`);
  if (envPer) return envPer;
  const vaultPer = await admin().rpc("get_secret", { p_name: `GHL_TOKEN_${svc}` });
  if (!vaultPer.error && vaultPer.data) return vaultPer.data as string;
  const envShared = Deno.env.get("GHL_TOKEN");
  if (envShared) return envShared;
  const { data, error } = await admin().rpc("get_secret", { p_name: "GHL_TOKEN" });
  if (error || !data) throw new Error(`No GHL token for ${serviceType}: set GHL_TOKEN_${svc} or GHL_TOKEN (env or Vault) (${error?.message ?? "not found"})`);
  return data as string;
}

async function ghlFetch(token: string, path: string, version: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Version": version,
      "Accept": "application/json",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) throw new Error(`GHL ${init.method ?? "GET"} ${path} → ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

// Read the calendar's assignable team AND its configured slot duration (in minutes).
// Duration lives in the GHL calendar settings, so the appointment length always
// matches exactly what you see on the calendar — we never hardcode it. If the
// calendar doesn't report a duration, we fall back to service_catalog.default_duration_min.
// (GHL round-robin calendars also REQUIRE assignedUserId on create — 422 if omitted —
//  so when a rep isn't pinned we pick one from teamUserIds ourselves.)
async function getCalendar(token: string, calendarId: string): Promise<{ teamUserIds: string[]; durationMin: number | null }> {
  const data = await ghlFetch(token, `/calendars/${calendarId}`, CAL_VERSION);
  const cal = data?.calendar ?? {};
  const teamUserIds = (cal.teamMembers ?? [])
    .filter((m: any) => m?.selected !== false && m?.userId)
    .map((m: any) => m.userId as string);
  let durationMin: number | null = null;
  if (typeof cal.slotDuration === "number" && cal.slotDuration > 0) {
    const unit = String(cal.slotDurationUnit ?? "mins").toLowerCase();
    durationMin = unit.startsWith("hour") ? cal.slotDuration * 60 : cal.slotDuration;
  }
  return { teamUserIds, durationMin };
}

// Least-loaded round-robin across the calendar's team, counted from our own
// booking_items (so distribution stays balanced and is auditable).
async function pickAssignee(serviceType: string, userIds: string[]): Promise<string> {
  if (userIds.length === 0) throw new Error("GHL calendar has no assignable team members");
  if (userIds.length === 1) return userIds[0];
  const { data } = await admin()
    .from("booking_items")
    .select("assigned_rep")
    .eq("service_type", serviceType)
    .eq("status", "booked")
    .in("assigned_rep", userIds);
  const counts: Record<string, number> = Object.fromEntries(userIds.map((u) => [u, 0]));
  for (const row of (data ?? [])) {
    const r = (row as any).assigned_rep;
    if (r in counts) counts[r]++;
  }
  return userIds.reduce((best, u) => (counts[u] < counts[best] ? u : best), userIds[0]);
}

export const ghlProvider: AvailabilityProvider = {
  // ---- Availability: GET /calendars/{calendarId}/free-slots ----
  async getAvailability(cfg, startMs, endMs, timezone) {
    if (!cfg.ghl_calendar_id) throw new Error(`service_catalog.${cfg.service_type}.ghl_calendar_id is empty`);
    const token = await tokenFor(cfg.service_type);
    // Appointment length follows the calendar's own slot-duration setting.
    const { durationMin } = await getCalendar(token, cfg.ghl_calendar_id);
    const durMin = durationMin ?? cfg.default_duration_min;
    const qs = new URLSearchParams({
      startDate: String(startMs),   // epoch milliseconds
      endDate: String(endMs),
      timezone,                     // IANA, e.g. America/Phoenix
    });
    const data = await ghlFetch(token, `/calendars/${cfg.ghl_calendar_id}/free-slots?${qs}`, CAL_VERSION);

    // Response is keyed by date: { "2026-06-20": { slots: ["...ISO..."] }, traceId: "..." }
    const slots: Slot[] = [];
    for (const [key, val] of Object.entries<any>(data)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue; // skip traceId and any non-date keys
      for (const start of (val?.slots ?? [])) {
        const end = new Date(new Date(start).getTime() + durMin * 60000).toISOString();
        slots.push({ start, end });
      }
    }
    return slots;
  },

  // ---- Booking: upsert contact, then create appointment ----
  async createBooking(cfg, input) {
    const token = await tokenFor(cfg.service_type);

    // 0) Pull the calendar once: its assignable team + its configured slot duration.
    const cal = await getCalendar(token, cfg.ghl_calendar_id!);
    const durMin = cal.durationMin ?? cfg.default_duration_min;

    //    Resolve the assignee. Pinned rep wins (e.g. drive-time-validated);
    //    otherwise least-loaded round-robin across the calendar's team.
    let assignedUserId = input.assignedUserId;
    if (!assignedUserId) {
      assignedUserId = await pickAssignee(cfg.service_type, cal.teamUserIds);
    }

    // Attribution tags so the source/campaign are visible right on the contact.
    const tags = [
      input.channel ? `Source: ${input.channel}` : null,
      input.campaign ? `Campaign: ${input.campaign}` : null,
      input.emergency ? "Emergency" : null,
    ].filter(Boolean) as string[];

    // 1) Upsert the customer as a GHL contact (reuses the one customer record).
    const parts = (input.customer.name || "").trim().split(/\s+/);
    const firstName = parts.shift() || input.customer.name;
    const lastName = parts.join(" ") || undefined;
    //    Only include email/phone/address when present & valid — a blank email
    //    string makes GHL 422 the entire upsert (phone-only leads are valid here).
    const contactBody: Record<string, unknown> = {
      locationId: cfg.ghl_location_id,
      firstName, lastName,
      name: input.customer.name,
      ...(tags.length ? { tags } : {}),
    };
    if (isValidEmail(input.customer.email)) contactBody.email = input.customer.email!.trim();
    if (input.customer.phone?.trim())       contactBody.phone = input.customer.phone.trim();
    if (input.customer.address?.trim())     contactBody.address1 = input.customer.address.trim();
    // Populate GHL's real "Source" field on the contact from the booking channel
    // (e.g. "LSA (Local Services Ads)"), in addition to the Source/Campaign tags above.
    if (input.channel) contactBody.source = input.channel;

    const cRes = await ghlFetch(token, `/contacts/upsert`, CONTACT_VERSION, {
      method: "POST",
      body: JSON.stringify(contactBody),
    });
    const contactId = cRes?.contact?.id ?? cRes?.id;
    if (!contactId) throw new Error(`GHL contact upsert returned no id: ${JSON.stringify(cRes)}`);

    // 2) Create the appointment. Access-critical bits (emergency, gate code) go in the
    //    title/address; the lead notes + attribution go in the event description below.
    const titleExtra = input.emergency ? " · ⚠ EMERGENCY" : "";
    const apptAddress = [input.customer.address, input.gateCode ? `Gate: ${input.gateCode}` : null].filter(Boolean).join(" · ");
    // Lead notes + attribution go onto the calendar EVENT itself (its description),
    // so the rep sees them right on the appointment — not just buried on the contact.
    // GHL renders the description as HTML and collapses plain "\n" newlines into one
    // paragraph, so we join with <br> to get each detail on its own line.
    const apptDescription = [
      input.notes ? `Lead notes: ${input.notes}` : null,
      input.channel ? `Lead source: ${input.channel}` : null,
      input.campaign ? `Campaign: ${input.campaign}` : null,
      input.gateCode ? `Gate code: ${input.gateCode}` : null,
      input.emergency ? "⚠ EMERGENCY" : null,
      input.customer.address ? `Address: ${input.customer.address}` : null,
    ].filter(Boolean).join("<br>");
    //    Omit assignedUserId  -> GHL round-robin assigns the rep.
    //    Pass  assignedUserId -> pin a specific (e.g. drive-time-validated) rep.
    const apptBody: Record<string, unknown> = {
      calendarId: cfg.ghl_calendar_id,
      locationId: cfg.ghl_location_id,
      contactId,
      startTime: input.slot.start,
      // End is derived from the calendar's slot-duration setting, so the booked
      // appointment length always matches the calendar (not a hardcoded DB value).
      endTime: new Date(new Date(input.slot.start).getTime() + durMin * 60000).toISOString(),
      title: `${cfg.label} — ${input.appointmentType}${titleExtra}`,
      ...(apptDescription ? { description: apptDescription } : {}),
      appointmentStatus: "confirmed",
      address: apptAddress || input.customer.address,
      assignedUserId,            // required by GHL round-robin calendars
      ignoreDateRange: false,
      // Our /availability endpoint + drive-time filter already govern which slots
      // reps can pick, so we tell GHL to trust that slot rather than re-validating
      // it. Without this, near-term/round-robin slots we legitimately offered get
      // rejected at booking time with 400 "The slot you have selected is no longer
      // available." (Tradeoff: GHL won't block a true simultaneous double-book.)
      ignoreFreeSlotValidation: true,
    };

    const aRes = await ghlFetch(token, `/calendars/events/appointments`, CAL_VERSION, {
      method: "POST",
      body: JSON.stringify(apptBody),
    });
    const apptId = aRes?.id ?? aRes?.appointment?.id;
    if (!apptId) throw new Error(`GHL create appointment returned no id: ${JSON.stringify(aRes)}`);

    // 3) Write a contact note with the full lead detail. The appointment has no notes
    //    field, but the note is one click from the event and visible to the whole team.
    //    Best-effort: a note failure must not fail an otherwise-successful booking.
    const noteLines = [
      `📅 ${cfg.label} — ${input.appointmentType}`,
      input.emergency ? "⚠ EMERGENCY" : null,
      input.gateCode ? `Gate code: ${input.gateCode}` : null,
      input.channel ? `Lead source: ${input.channel}` : null,
      input.campaign ? `Campaign: ${input.campaign}` : null,
      input.customer.address ? `Address: ${input.customer.address}` : null,
      input.notes ? `\nLead notes:\n${input.notes}` : null,
    ].filter(Boolean);
    if (noteLines.length > 1) {
      try {
        await ghlFetch(token, `/contacts/${contactId}/notes`, CONTACT_VERSION, {
          method: "POST",
          body: JSON.stringify({ body: noteLines.join("\n") }),
        });
      } catch (_) { /* note is best-effort */ }
    }

    return {
      providerRef: apptId,
      assignedRep: aRes?.assignedUserId ?? assignedUserId,
      status: "booked",
    };
  },
};
