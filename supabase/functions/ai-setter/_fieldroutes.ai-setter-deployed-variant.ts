// =====================================================================
// FieldRoutes (PestRoutes) adapter — Pest Control (Pestkee)
// Spot scheduling, sold-customer close, lead upsert, notes, and
// subscription lifecycle listing for the GHL tag sync.
// =====================================================================

import type {
  AvailabilityProvider, ServiceConfig, Slot, BookingInput, BookingResult, CustomerInput,
} from "./providers.ts";
import { admin } from "./db.ts";

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

function pickId(data: any, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = data?.[n];
    if (v !== undefined && v !== null && v !== "" && v !== 0 && v !== "0") return String(Array.isArray(v) ? v[0] : v);
  }
  return undefined;
}

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

async function upsertCustomer(cfg: ServiceConfig, c: CustomerInput, channel?: string): Promise<string> {
  const officeID = cfg.fr_office_id!;
  const phoneDigits = (c.phone ?? "").replace(/\D/g, "");

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

// ---- exports for the AI setter ----

export async function frUpsertLead(cfg: ServiceConfig, c: CustomerInput, note?: string): Promise<string> {
  const id = await upsertCustomer(cfg, c);
  if (note) {
    try { await frFetch("note/create", { officeID: cfg.fr_office_id, customerID: id, notes: note, showOnInvoice: 0 }); } catch { /* best effort */ }
  }
  return id;
}

export async function frCreateNote(cfg: ServiceConfig, customerID: string, note: string) {
  return await frFetch("note/create", { officeID: cfg.fr_office_id, customerID, notes: note, showOnInvoice: 0 });
}

export async function frListSubscriptions(cfg: ServiceConfig): Promise<{ subscriptionID?: string; customerID: string; status: string }[]> {
  const data = await frFetch("subscription/search", { officeIDs: cfg.fr_office_id, includeData: 1 });
  let subs: any[] = data?.subscriptions ?? data?.subscription ?? [];
  if (!Array.isArray(subs)) subs = [subs].filter(Boolean);
  if (subs.length === 0 && Array.isArray(data?.subscriptionIDs) && data.subscriptionIDs.length) {
    const ids = data.subscriptionIDs.slice(0, 3000);
    for (let i = 0; i < ids.length; i += 1000) {
      const got = await frFetch("subscription/get", { subscriptionIDs: ids.slice(i, i + 1000).join(",") });
      let s: any = got?.subscriptions ?? got?.subscription ?? [];
      subs.push(...(Array.isArray(s) ? s : [s]));
    }
  }
  return subs.map((s: any) => {
    const cancelled = String(s?.dateCancelled ?? "").trim();
    const isCancelled = cancelled && !cancelled.startsWith("0000") && cancelled.toLowerCase() !== "null";
    const status = String(s?.active) === "1" ? "active" : (isCancelled ? "inactive" : "paused");
    return { subscriptionID: pickId(s, "subscriptionID"), customerID: String(s?.customerID ?? ""), status };
  }).filter((x: any) => x.customerID && x.customerID !== "0");
}

export async function frGetCustomer(cfg: ServiceConfig, customerID: string): Promise<{ name: string; phone: string; email: string }> {
  const data = await frFetch("customer/get", { customerIDs: customerID });
  let cs: any[] = data?.customers ?? data?.customer ?? [];
  if (!Array.isArray(cs)) cs = [cs];
  const c = cs[0] ?? {};
  return {
    name: [c?.fname, c?.lname].filter(Boolean).join(" ").trim(),
    phone: String(c?.phone1 ?? "").trim(),
    email: String(c?.email ?? "").trim(),
  };
}

export const frProvider: AvailabilityProvider = {
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

    let spots: any[] = data?.spots ?? data?.spot ?? [];
    if (!Array.isArray(spots)) spots = [spots];
    if (spots.length === 0 && Array.isArray(data?.spotIDs) && data.spotIDs.length > 0) {
      const ids: any[] = data.spotIDs.slice(0, 3000);
      for (let i = 0; i < ids.length; i += 1000) {
        const got = await frFetch("spot/get", { spotIDs: ids.slice(i, i + 1000).join(",") });
        spots.push(...(got?.spots ?? []));
      }
    }

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
      type: cfg.fr_service_type_id,
      duration: cfg.default_duration_min,
      notes: noteLines || undefined,
      employeeID: input.assignedUserId || input.slot.assignedUserId || undefined,
      rejectOccupiedSpots: 1,
    };
    if (input.slot.ref) {
      params.spotID = input.slot.ref;
    } else {
      params.start = input.slot.start;
      params.end = input.slot.end;
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

export interface SaleInput {
  customer: CustomerInput;
  initialCharge: number;
  serviceCharge?: number;
  frequencyDays?: number;
  agreementLengthMonths?: number;
  soldByEmployeeID?: string;
  notes?: string;
  channel?: string;
  campaign?: string;
  emailContract?: boolean;
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
  const frequency = sale.frequencyDays ?? (recurring ? 90 : -1);

  const subParams: Record<string, unknown> = {
    officeID: cfg.fr_office_id,
    customerID,
    serviceID: cfg.fr_service_type_id,
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

  const noteText = [
    `Sold via Growth AI setter`,
    sale.notes ? `Notes: ${sale.notes}` : null,
    sale.channel ? `Lead source: ${sale.channel}` : null,
    sale.campaign ? `Campaign: ${sale.campaign}` : null,
  ].filter(Boolean).join(" | ");
  try {
    await frFetch("note/create", { officeID: cfg.fr_office_id, customerID, notes: noteText, showOnInvoice: 0 });
  } catch { /* best-effort */ }

  let contractSent = false;
  let contractError: string | undefined;
  if (sale.emailContract !== false) {
    try {
      await frFetch("contract/create", { subscriptionID, emailCustomer: 1 });
      contractSent = true;
    } catch (e) {
      contractError = String((e as Error)?.message ?? e);
    }
  }

  return { customerID, subscriptionID, contractSent, contractError };
}
