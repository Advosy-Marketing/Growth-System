// =====================================================================
// FieldRoutes (PestRoutes) adapter — Pest Control (Pestkee)
// Real calls against https://{FR_SUBDOMAIN}.fieldroutes.com/api
//
// Auth: key + token pair sent on every request, stored as Supabase
// secrets (env or Vault): FR_SUBDOMAIN, FR_AUTH_KEY, FR_AUTH_TOKEN.
// Office + serviceType IDs come from the service_catalog row
// (fr_office_id, fr_service_type_id) — use the fr-lookup function to
// discover them.
//
// Scheduling model: FieldRoutes books against "spots" — pre-built
// openings on a tech's route. getAvailability lists open spots
// (apiCanSchedule routes only); createBooking pins the appointment to
// the chosen spotID, so the tech/route assignment is native.
//
// Also exports frCreateSale (not part of AvailabilityProvider):
// customer -> subscription (pricing + soldBy) -> contract/create with
// emailCustomer=1 (FieldRoutes emails the e-sign link directly).
// =====================================================================

import type {
  AvailabilityProvider, ServiceConfig, Slot, BookingInput, BookingResult, CustomerInput,
} from "./providers.ts";
import { admin } from "./db.ts";

// ---- credentials (env first, Vault fallback — same pattern as GHL) ----
async function secret(name: string): Promise<string> {
  const env = Deno.env.get(name);
  if (env) return env;
  const { data, error } = await admin().rpc("get_secret", { p_name: name });
  if (error || !data) throw new Error(`Missing secret ${name} (env or Vault): ${error?.message ?? "not found"}`);
  return data as string;
}

async function frCreds(): Promise<{ base: string; key: string; token: string }> {
  const [sub, key, token] = await Promise.all([
    secret("FR_SUBDOMAIN"), secret("FR_AUTH_KEY"), secret("FR_AUTH_TOKEN"),
  ]);
  return { base: `https://${sub}.fieldroutes.com/api`, key, token };
}

// ---- transport ----
// POST form-encoded. Auth params go LAST — per FieldRoutes docs, sending
// key/token as the final inputs ensures a truncated request can never
// execute with partial parameters.
async function frFetch(action: string, params: Record<string, unknown>): Promise<any> {
  const { base, key, token } = await frCreds();
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    body.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  body.append("authenticationKey", key);
  body.append("authenticationToken", token);

  const res = await fetch(`${base}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body: body.toString(),
  });
  const text = await res.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`FieldRoutes ${action} → HTTP ${res.status}: ${text.slice(0, 400)}`);
  const ok = data?.success === true || data?.success === "true" || data?.success === 1 || data?.success === "1";
  if (!ok) throw new Error(`FieldRoutes ${action} failed: ${data?.errorMessage ?? text.slice(0, 400)}`);
  return data;
}

// FieldRoutes create/search responses name the ID field after the resource
// (customerID, appointmentID, subscriptionID, ...). Resolve defensively.
function pickId(data: any, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = data?.[n];
    if (v !== undefined && v !== null && v !== "" && v !== 0 && v !== "0") return String(Array.isArray(v) ? v[0] : v);
  }
  return undefined;
}

// ---- time helpers ----
// Spots come back with a local `date` (YYYY-MM-DD) and local start/end times.
// Convert to ISO-8601 with the correct UTC offset for the office timezone.
function tzOffsetString(tz: string, atUtcMs: number): string {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, timeZoneName: "longOffset",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
  });
  const part = dtf.formatToParts(new Date(atUtcMs)).find((p) => p.type === "timeZoneName")?.value ?? "GMT-07:00";
  const m = part.match(/GMT([+-]\d{2}:\d{2})/);
  return m ? m[1] : "-07:00";
}

function normTime(t: string): string | null {
  // Accepts "08:00:00", "8:00", "8:00 AM", "13:30" → "HH:MM:SS"
  const s = String(t ?? "").trim();
  if (!s) return null;
  const ampm = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!ampm) return null;
  let h = parseInt(ampm[1], 10);
  const min = ampm[2], sec = ampm[3] ?? "00";
  const ap = ampm[4]?.toUpperCase();
  if (ap === "PM" && h < 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${min}:${sec}`;
}

function toIso(dateYmd: string, time: string, tz: string): string | null {
  const t = normTime(time);
  if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(dateYmd)) return null;
  const offset = tzOffsetString(tz, Date.parse(`${dateYmd}T12:00:00Z`));
  return `${dateYmd}T${t}${offset}`;
}

function ymdInTz(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

// ---- employees (tech names for slots; best-effort, cached per invocation) ----
async function employeeNames(ids: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(ids.filter((i) => i && i !== "0"))];
  if (unique.length === 0) return {};
  try {
    const data = await frFetch("employee/get", { employeeIDs: unique.join(",") });
    const list: any[] = data?.employees ?? data?.employee ?? [];
    const map: Record<string, string> = {};
    for (const e of Array.isArray(list) ? list : [list]) {
      const id = pickId(e, "employeeID");
      if (id) map[id] = [e?.fname, e?.lname].filter(Boolean).join(" ") || `Tech ${id}`;
    }
    return map;
  } catch { return {}; }
}

// ---- customer upsert (search by phone/email within the office, else create) ----
async function upsertCustomer(cfg: ServiceConfig, c: CustomerInput, channel?: string): Promise<string> {
  const officeID = cfg.fr_office_id!;
  const phoneDigits = (c.phone ?? "").replace(/\D/g, "");

  // 1) search by phone, then email
  for (const filter of [
    phoneDigits.length >= 10 ? { phone1: phoneDigits.slice(-10) } : null,
    c.email?.trim() ? { email: c.email.trim() } : null,
  ]) {
    if (!filter) continue;
    try {
      const found = await frFetch("customer/search", { officeIDs: officeID, ...filter });
      const ids: any[] = found?.customerIDs ?? [];
      if (Array.isArray(ids) && ids.length > 0) return String(ids[0]);
    } catch { /* fall through to create */ }
  }

  // 2) create
  const parts = (c.name || "").trim().split(/\s+/);
  const fname = parts.shift() || c.name;
  const lname = parts.join(" ") || "-";
  const params: Record<string, unknown> = {
    officeID, fname, lname,
    phone1: phoneDigits || undefined,
    email: c.email?.trim() || undefined,
    address: c.street ?? c.address ?? undefined,
    city: c.city ?? undefined,
    state: c.state ?? undefined,
    zip: c.zip ?? undefined,
    status: 1,
    notes: channel ? `Lead source: ${channel}` : undefined,
  };
  const created = await frFetch("customer/create", params);
  const id = pickId(created, "customerID", "result", "id");
  if (!id) throw new Error(`FieldRoutes customer/create returned no id: ${JSON.stringify(created).slice(0, 300)}`);
  return id;
}

// =====================================================================
// AvailabilityProvider
// =====================================================================
export const frProvider: AvailabilityProvider = {
  // ---- Availability: spot/search (open, API-schedulable spots) ----
  async getAvailability(cfg, startMs, endMs, timezone) {
    if (!cfg.fr_office_id) throw new Error(`service_catalog.${cfg.service_type}.fr_office_id is empty`);
    const startDate = ymdInTz(startMs, timezone);
    const endDate = ymdInTz(endMs, timezone);

    const data = await frFetch("spot/search", {
      officeIDs: cfg.fr_office_id,
      date: { operator: "BETWEEN", value: [startDate, endDate] },
      apiCanSchedule: 1,
      includeData: 1,
    });

    // includeData resolves the first 1000 spots inline (plenty for a 1–2 week window).
    let spots: any[] = data?.spots ?? data?.spot ?? [];
    if (!Array.isArray(spots)) spots = [spots];
    if (spots.length === 0 && Array.isArray(data?.spotIDs) && data.spotIDs.length > 0) {
      // Fallback: resolve in chunks of 1000 via spot/get.
      const ids: any[] = data.spotIDs.slice(0, 3000);
      for (let i = 0; i < ids.length; i += 1000) {
        const got = await frFetch("spot/get", { spotIDs: ids.slice(i, i + 1000).join(",") });
        spots.push(...(got?.spots ?? []));
      }
    }

    // Keep only genuinely open spots.
    const open = spots.filter((s) => {
      const taken = pickId(s, "currentAppointment", "appointmentID", "currentAppointmentID");
      const reserved = String(s?.reserved ?? "0") === "1";
      const blocked = String(s?.blockReason ?? "").trim() !== "" || String(s?.isBlocked ?? "0") === "1";
      const api = s?.apiCanSchedule === undefined || String(s.apiCanSchedule) === "1";
      return !taken && !reserved && !blocked && api;
    });

    const techMap = await employeeNames(open.map((s) => String(s?.assignedTech ?? "")));

    const slots: Slot[] = [];
    for (const s of open) {
      const date = String(s?.date ?? "").slice(0, 10);
      const start = toIso(date, s?.start ?? s?.startTime ?? "", timezone);
      const end = toIso(date, s?.end ?? s?.endTime ?? "", timezone)
        ?? (start ? new Date(Date.parse(start) + cfg.default_duration_min * 60000).toISOString() : null);
      if (!start || !end) continue;
      const tech = String(s?.assignedTech ?? "") || undefined;
      slots.push({
        start, end,
        assignedRep: tech ? techMap[tech] : undefined,
        assignedUserId: tech,
        ref: pickId(s, "spotID"),
      });
    }
    slots.sort((a, b) => a.start.localeCompare(b.start));
    return slots;
  },

  // ---- Booking: upsert customer, create appointment pinned to the spot ----
  async createBooking(cfg, input) {
    if (!cfg.fr_office_id) throw new Error(`service_catalog.${cfg.service_type}.fr_office_id is empty`);
    if (!cfg.fr_service_type_id) throw new Error(`service_catalog.${cfg.service_type}.fr_service_type_id is empty`);

    const customerID = await upsertCustomer(cfg, input.customer, input.channel);

    const noteLines = [
      input.notes ? `Lead notes: ${input.notes}` : null,
      input.channel ? `Lead source: ${input.channel}` : null,
      input.campaign ? `Campaign: ${input.campaign}` : null,
      input.gateCode ? `Gate code: ${input.gateCode}` : null,
      input.emergency ? "EMERGENCY" : null,
    ].filter(Boolean).join(" | ");

    const params: Record<string, unknown> = {
      officeID: cfg.fr_office_id,
      customerID,
      type: cfg.fr_service_type_id,       // serviceID to perform
      notes: noteLines || undefined,
      employeeID: input.assignedUserId || input.slot.assignedUserId || undefined,
      rejectOccupiedSpots: 1,             // fail loudly instead of double-booking a spot
    };
    // Pin to the exact spot the rep picked (slot.ref = spotID from getAvailability).
    // IMPORTANT: when booking into a spot, do NOT send duration — spots hold
    // ~24 min and FieldRoutes rejects anything over capacity ("Could not find
    // capacity on the route"). Omitting it uses the service type's own default
    // length (verified live: type 34 Inspection = 20 min fits).
    if (input.slot.ref) {
      params.spotID = input.slot.ref;
    } else {
      // Fallback: schedule by time window if the slot has no spot reference.
      params.start = input.slot.start;
      params.end = input.slot.end;
      params.duration = cfg.default_duration_min;
    }

    const created = await frFetch("appointment/create", params);
    const apptId = pickId(created, "appointmentID", "result", "id");
    if (!apptId) throw new Error(`FieldRoutes appointment/create returned no id: ${JSON.stringify(created).slice(0, 300)}`);

    return {
      providerRef: apptId,
      assignedRep: input.slot.assignedRep,
      status: "booked",
    } as BookingResult;
  },
};

// =====================================================================
// frCreateSale — the "New Sold Customer" close, pushed into FieldRoutes:
//   customer -> subscription (pricing, soldBy) -> contract e-sign email.
// Called from /book for pest sold_customer items. Not part of the
// AvailabilityProvider interface.
// =====================================================================
// Pestkee plan serviceIDs by cadence (from serviceType/search, office 1):
//   one-time → 32 "One-Time", 30d → 7 "Residential Monthly",
//   60d → 5 "Residential Bi-Monthly", 90d → 9 "Residential Quarterly".
// Other cadences fall back to Quarterly. Override per-sale via SaleInput.serviceID.
const FR_PLAN_BY_FREQ: Record<string, string> = { "-1": "32", "30": "7", "60": "5", "90": "9" };

export interface SaleInput {
  customer: CustomerInput;
  initialCharge: number;        // charged on the initial service (contract value for one-time)
  serviceCharge?: number;       // recurring per-service charge (0/absent = one-time)
  frequencyDays?: number;       // service cadence in days (30/60/90/365); -1 = one-time
  serviceID?: string;           // FieldRoutes serviceType for the subscription (defaults from cadence)
  agreementLengthMonths?: number;
  soldByEmployeeID?: string;    // FieldRoutes employeeID who gets sale credit
  notes?: string;
  channel?: string;
  campaign?: string;
  emailContract?: boolean;      // default true — FieldRoutes emails the e-sign link
}

export interface SaleResult {
  customerID: string;
  subscriptionID: string;
  contractSent: boolean;
  contractError?: string;
}

export async function frCreateSale(cfg: ServiceConfig, sale: SaleInput): Promise<SaleResult> {
  if (!cfg.fr_office_id) throw new Error(`service_catalog.${cfg.service_type}.fr_office_id is empty`);
  if (!cfg.fr_service_type_id) throw new Error(`service_catalog.${cfg.service_type}.fr_service_type_id is empty`);

  const customerID = await upsertCustomer(cfg, sale.customer, sale.channel);

  const recurring = (sale.serviceCharge ?? 0) > 0;
  // Default cadence: quarterly for recurring pest plans, one-time otherwise.
  const frequency = sale.frequencyDays ?? (recurring ? 90 : -1);
  // Subscription serviceID = the PLAN sold (Monthly/Bi-Monthly/Quarterly/One-Time),
  // not the catalog's appointment service type.
  const serviceID = sale.serviceID ?? FR_PLAN_BY_FREQ[String(frequency)] ?? FR_PLAN_BY_FREQ["90"];

  const subParams: Record<string, unknown> = {
    officeID: cfg.fr_office_id,
    customerID,
    serviceID,
    active: 1,
    frequency,
    initialCharge: sale.initialCharge,
    serviceCharge: recurring ? sale.serviceCharge : sale.initialCharge,
    agreementLength: sale.agreementLengthMonths ?? undefined,
    soldBy: sale.soldByEmployeeID ?? undefined,
  };
  const subRes = await frFetch("subscription/create", subParams);
  const subscriptionID = pickId(subRes, "subscriptionID", "result", "id");
  if (!subscriptionID) throw new Error(`FieldRoutes subscription/create returned no id: ${JSON.stringify(subRes).slice(0, 300)}`);

  // Attach the sale detail as a customer note (best-effort).
  const noteText = [
    `Sold via Growth booking app`,
    sale.notes ? `Notes: ${sale.notes}` : null,
    sale.channel ? `Lead source: ${sale.channel}` : null,
    sale.campaign ? `Campaign: ${sale.campaign}` : null,
  ].filter(Boolean).join(" | ");
  try {
    await frFetch("note/create", { officeID: cfg.fr_office_id, customerID, notes: noteText, showOnInvoice: 0 });
  } catch { /* best-effort */ }

  // Generate the default contract for the subscription and email the
  // customer an e-sign link straight from FieldRoutes.
  let contractSent = false;
  let contractError: string | undefined;
  if (sale.emailContract !== false) {
    try {
      await frFetch("contract/create", { subscriptionID, emailCustomer: 1 });
      contractSent = true;
    } catch (e) {
      contractError = String((e as Error)?.message ?? e); // sale still stands; surface the error
    }
  }

  return { customerID, subscriptionID, contractSent, contractError };
}
