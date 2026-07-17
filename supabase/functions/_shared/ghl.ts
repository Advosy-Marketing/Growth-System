// =====================================================================
// GoHighLevel (v2) adapter — Roofing (VRZA) & Restoration (Bloque)
// =====================================================================

import type {
  AvailabilityProvider, ServiceConfig, Slot, BookingInput, BookingResult,
} from "./providers.ts";
import { admin } from "./db.ts";

const BASE = "https://services.leadconnectorhq.com";
const CAL_VERSION = "2021-04-15";
const CONTACT_VERSION = "2021-07-28";

const isValidEmail = (e?: string): boolean =>
  !!e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

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

// =====================================================================
// markOpportunityWon — close the attribution loop on phone sales.
// When the booking app pushes a sale into FieldRoutes, the lead usually
// lives in GHL (Thumbtack/Meta/etc.) with an OPEN opportunity that would
// otherwise rot into "lost" via stale-lead automations. This finds the
// contact by phone/email, then marks their most recent open opportunity
// WON with the sale's monetary value. Fully best-effort: any failure is
// returned as info, never thrown — a CRM sync miss must not fail a sale.
// Location: GHL_LOCATION_ID env, falling back to the shared sub-account.
// =====================================================================
const SHARED_LOCATION_ID = "z4t41ywW9EayYdtYsUBH";

export interface OppWonResult {
  ok: boolean;
  contactId?: string;
  opportunityId?: string;
  detail: string;
}

export async function markOpportunityWon(
  customer: { phone?: string; email?: string; name?: string },
  valueUSD?: number,
): Promise<OppWonResult> {
  try {
    const token = await tokenFor("pest_control"); // per-line token or shared GHL_TOKEN
    const locationId = Deno.env.get("GHL_LOCATION_ID") || SHARED_LOCATION_ID;

    // 1) Find the contact (phone first, then email).
    let contactId: string | undefined;
    for (const q of [customer.phone?.trim(), customer.email?.trim()]) {
      if (!q) continue;
      try {
        const qs = new URLSearchParams({ locationId, query: q, limit: "3" });
        const found = await ghlFetch(token, `/contacts/?${qs}`, CONTACT_VERSION);
        const c = (found?.contacts ?? [])[0];
        if (c?.id) { contactId = c.id; break; }
      } catch (_) { /* try next identifier */ }
    }
    if (!contactId) return { ok: false, detail: "no GHL contact matched phone/email" };

    // 2) Find their most recent OPEN opportunity.
    const qs = new URLSearchParams({ location_id: locationId, contact_id: contactId, limit: "20" });
    const search = await ghlFetch(token, `/opportunities/search?${qs}`, CONTACT_VERSION);
    const opps: any[] = search?.opportunities ?? [];
    const open = opps
      .filter((o) => String(o?.status ?? "").toLowerCase() === "open")
      .sort((a, b) => String(b?.updatedAt ?? "").localeCompare(String(a?.updatedAt ?? "")));
    const target = open[0] ?? opps.sort((a, b) => String(b?.updatedAt ?? "").localeCompare(String(a?.updatedAt ?? "")))[0];
    if (!target?.id) return { ok: false, contactId, detail: "contact has no opportunities" };

    // 3) Mark it won (+ monetary value when we have one).
    const body: Record<string, unknown> = { status: "won" };
    if (valueUSD && valueUSD > 0) body.monetaryValue = valueUSD;
    await ghlFetch(token, `/opportunities/${target.id}`, CONTACT_VERSION, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    return { ok: true, contactId, opportunityId: target.id, detail: `opportunity ${target.id} marked won` };
  } catch (e) {
    return { ok: false, detail: String((e as Error)?.message ?? e) };
  }
}

export const ghlProvider: AvailabilityProvider = {
  async getAvailability(cfg, startMs, endMs, timezone) {
    if (!cfg.ghl_calendar_id) throw new Error(`service_catalog.${cfg.service_type}.ghl_calendar_id is empty`);
    const token = await tokenFor(cfg.service_type);
    const { durationMin } = await getCalendar(token, cfg.ghl_calendar_id);
    const durMin = durationMin ?? cfg.default_duration_min;
    const qs = new URLSearchParams({
      startDate: String(startMs),
      endDate: String(endMs),
      timezone,
    });
    const data = await ghlFetch(token, `/calendars/${cfg.ghl_calendar_id}/free-slots?${qs}`, CAL_VERSION);

    const slots: Slot[] = [];
    for (const [key, val] of Object.entries<any>(data)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
      for (const start of (val?.slots ?? [])) {
        const end = new Date(new Date(start).getTime() + durMin * 60000).toISOString();
        slots.push({ start, end });
      }
    }
    return slots;
  },

  async createBooking(cfg, input) {
    const token = await tokenFor(cfg.service_type);

    const cal = await getCalendar(token, cfg.ghl_calendar_id!);
    const durMin = cal.durationMin ?? cfg.default_duration_min;

    let assignedUserId = input.assignedUserId;
    if (!assignedUserId) {
      assignedUserId = await pickAssignee(cfg.service_type, cal.teamUserIds);
    }

    const tags = [
      input.channel ? `Source: ${input.channel}` : null,
      input.campaign ? `Campaign: ${input.campaign}` : null,
      input.emergency ? "Emergency" : null,
    ].filter(Boolean) as string[];

    const parts = (input.customer.name || "").trim().split(/\s+/);
    const firstName = parts.shift() || input.customer.name;
    const lastName = parts.join(" ") || undefined;
    const contactBody: Record<string, unknown> = {
      locationId: cfg.ghl_location_id,
      firstName, lastName,
      name: input.customer.name,
      ...(tags.length ? { tags } : {}),
    };
    if (isValidEmail(input.customer.email)) contactBody.email = input.customer.email!.trim();
    if (input.customer.phone?.trim())       contactBody.phone = input.customer.phone.trim();
    if (input.customer.address?.trim())     contactBody.address1 = input.customer.address.trim();
    if (input.channel) contactBody.source = input.channel;

    const cRes = await ghlFetch(token, `/contacts/upsert`, CONTACT_VERSION, {
      method: "POST",
      body: JSON.stringify(contactBody),
    });
    const contactId = cRes?.contact?.id ?? cRes?.id;
    if (!contactId) throw new Error(`GHL contact upsert returned no id: ${JSON.stringify(cRes)}`);

    const titleExtra = input.emergency ? " · ⚠ EMERGENCY" : "";
    const apptAddress = [input.customer.address, input.gateCode ? `Gate: ${input.gateCode}` : null].filter(Boolean).join(" · ");
    const apptDescription = [
      input.notes ? `Lead notes: ${input.notes}` : null,
      input.channel ? `Lead source: ${input.channel}` : null,
      input.campaign ? `Campaign: ${input.campaign}` : null,
      input.gateCode ? `Gate code: ${input.gateCode}` : null,
      input.emergency ? "⚠ EMERGENCY" : null,
      input.customer.address ? `Address: ${input.customer.address}` : null,
    ].filter(Boolean).join("<br>");
    const apptBody: Record<string, unknown> = {
      calendarId: cfg.ghl_calendar_id,
      locationId: cfg.ghl_location_id,
      contactId,
      startTime: input.slot.start,
      endTime: new Date(new Date(input.slot.start).getTime() + durMin * 60000).toISOString(),
      title: `${cfg.label} — ${input.appointmentType}${titleExtra}`,
      ...(apptDescription ? { description: apptDescription } : {}),
      appointmentStatus: "confirmed",
      address: apptAddress || input.customer.address,
      assignedUserId,
      ignoreDateRange: false,
      ignoreFreeSlotValidation: true,
    };

    const aRes = await ghlFetch(token, `/calendars/events/appointments`, CAL_VERSION, {
      method: "POST",
      body: JSON.stringify(apptBody),
    });
    const apptId = aRes?.id ?? aRes?.appointment?.id;
    if (!apptId) throw new Error(`GHL create appointment returned no id: ${JSON.stringify(aRes)}`);

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
