// =====================================================================
// POST /functions/v1/sales   — Pestkee point-of-sale + light CRM for Growth
//
// Actions (body.action):
//   "options"         -> live FieldRoutes plans / sources / employees.
//   "availability"    -> open, API-schedulable spots for the first service.
//   "customer_search" -> live customer lookup by name / phone / email
//                        (dedup: link an existing account instead of dup).
//   "customer_get"    -> one customer + their subscriptions/services.
//   "create"          -> full new sale (customer -> subscription -> agreement
//                        -> billing -> optional first appointment).
//   "add_service"     -> add a subscription/service to an EXISTING customer.
//
// Self-contained (no _shared imports) so it deploys cleanly and can't
// break the booking / ai-setter functions.
//
// Secrets: FR_SUBDOMAIN, FR_AUTH_KEY, FR_AUTH_TOKEN,
//          SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-provided).
// =====================================================================

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

const DEFAULT_OFFICE = "1";
const TZ = "America/Phoenix";

// ---------------------------------------------------------------------
// FieldRoutes client
// ---------------------------------------------------------------------
function frBase() {
  const sub = Deno.env.get("FR_SUBDOMAIN"), key = Deno.env.get("FR_AUTH_KEY"), token = Deno.env.get("FR_AUTH_TOKEN");
  if (!sub || !key || !token) throw new Error("FieldRoutes secrets missing (FR_SUBDOMAIN / FR_AUTH_KEY / FR_AUTH_TOKEN)");
  return { base: `https://${sub}.fieldroutes.com/api`, key, token };
}
function frPortalUrl(): string | null {
  const sub = Deno.env.get("FR_SUBDOMAIN");
  return sub ? `https://${sub}.fieldroutes.com` : null;
}
async function frFetch(action: string, params: Record<string, unknown>): Promise<any> {
  const { base, key, token } = frBase();
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
  if (!res.ok) throw new Error(`FieldRoutes ${action} -> HTTP ${res.status}: ${text.slice(0, 400)}`);
  const ok = data?.success === true || data?.success === "true" || data?.success === 1 || data?.success === "1";
  if (!ok) throw new Error(`FieldRoutes ${action} failed: ${data?.errorMessage ?? text.slice(0, 400)}`);
  return data;
}
async function frTry(action: string, params: Record<string, unknown>): Promise<any> {
  try { return await frFetch(action, params); }
  catch (e) { return { __error: String((e as Error)?.message ?? e) }; }
}
function pickId(data: any, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = data?.[n];
    if (v !== undefined && v !== null && v !== "" && v !== 0 && v !== "0") {
      const s = Array.isArray(v) ? v[0] : v;
      if (s !== undefined && s !== null && String(s) !== "" && String(s) !== "[]") return String(s);
    }
  }
  return undefined;
}
function asArray(x: any): any[] { return Array.isArray(x) ? x : (x == null ? [] : [x]); }
function num(v: any): number | null { const n = Number(v); return Number.isFinite(n) && String(v).trim() !== "" ? n : null; }

// ---------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------
function tzOffset(tz: string, atUtcMs: number): string {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" });
  const part = dtf.formatToParts(new Date(atUtcMs)).find((p) => p.type === "timeZoneName")?.value ?? "GMT-07:00";
  const m = part.match(/GMT([+-]\d{2}:\d{2})/);
  return m ? m[1] : "-07:00";
}
function normTime(t: string): string | null {
  const s = String(t ?? "").trim(); if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10); const min = m[2], sec = m[3] ?? "00"; const ap = m[4]?.toUpperCase();
  if (ap === "PM" && h < 12) h += 12; if (ap === "AM" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${min}:${sec}`;
}
function toIso(dateYmd: string, time: string, tz: string): string | null {
  const t = normTime(time);
  if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(dateYmd)) return null;
  return `${dateYmd}T${t}${tzOffset(tz, Date.parse(`${dateYmd}T12:00:00Z`))}`;
}
function ymdInTz(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}
async function employeeNames(ids: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(ids.filter((i) => i && i !== "0"))];
  if (!unique.length) return {};
  const data = await frTry("employee/get", { employeeIDs: unique.join(",") });
  const map: Record<string, string> = {};
  for (const e of asArray(data?.employees ?? data?.employee)) {
    const id = pickId(e, "employeeID");
    if (id) map[id] = [e?.fname, e?.lname].filter(Boolean).join(" ") || `Tech ${id}`;
  }
  return map;
}

// ---------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------
async function getOptions(officeID: string) {
  const scope = { officeIDs: officeID, includeData: 1 };
  const [svcRes, srcRes, empRes] = await Promise.all([
    frTry("serviceType/search", scope),
    frTry("customerSource/search", scope),
    frTry("employee/search", { ...scope, active: 1 }),
  ]);
  const plans = asArray(svcRes?.serviceTypes ?? svcRes?.serviceType).map((s: any) => ({
    serviceID: pickId(s, "typeID", "serviceTypeID", "id"),
    name: s?.description ?? s?.name ?? `Service ${pickId(s, "typeID", "serviceTypeID")}`,
    initialCharge: num(s?.initialCharge ?? s?.defaultCharge),
    serviceCharge: num(s?.recurringCharge ?? s?.defaultCharge),
    frequencyDays: num(s?.frequency),
    category: s?.category ?? null,
  })).filter((p: any) => p.serviceID);
  const sources = asArray(srcRes?.sources ?? srcRes?.source ?? srcRes?.customerSources).map((s: any) => ({
    sourceID: pickId(s, "sourceID", "id"),
    name: s?.source ?? s?.name ?? s?.description ?? `Source ${pickId(s, "sourceID", "id")}`,
  })).filter((s: any) => s.sourceID);
  const employees = asArray(empRes?.employees ?? empRes?.employee).map((e: any) => ({
    employeeID: pickId(e, "employeeID", "id"),
    name: [e?.fname, e?.lname].filter(Boolean).join(" ") || `Employee ${pickId(e, "employeeID")}`,
  })).filter((e: any) => e.employeeID);
  return { officeID, plans, sources, employees, errors: { plans: svcRes?.__error ?? null, sources: srcRes?.__error ?? null, employees: empRes?.__error ?? null } };
}

// ---------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------
async function getAvailability(officeID: string, startMs: number, endMs: number, defaultDurationMin: number) {
  const data = await frFetch("spot/search", {
    officeIDs: officeID,
    date: { operator: "BETWEEN", value: [ymdInTz(startMs, TZ), ymdInTz(endMs, TZ)] },
    apiCanSchedule: 1, includeData: 1,
  });
  let spots: any[] = asArray(data?.spots ?? data?.spot);
  if (!spots.length && Array.isArray(data?.spotIDs) && data.spotIDs.length) {
    const ids: any[] = data.spotIDs.slice(0, 3000);
    for (let i = 0; i < ids.length; i += 1000) {
      const got = await frFetch("spot/get", { spotIDs: ids.slice(i, i + 1000).join(",") });
      spots.push(...asArray(got?.spots));
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
  const slots = [];
  for (const s of open) {
    const date = String(s?.date ?? "").slice(0, 10);
    const start = toIso(date, s?.start ?? s?.startTime ?? "", TZ);
    const end = toIso(date, s?.end ?? s?.endTime ?? "", TZ) ?? (start ? new Date(Date.parse(start) + defaultDurationMin * 60000).toISOString() : null);
    if (!start || !end) continue;
    const winMin = Math.max(15, Math.round((Date.parse(end) - Date.parse(start)) / 60000));
    const tech = String(s?.assignedTech ?? "") || undefined;
    slots.push({ start, end, date, spotID: pickId(s, "spotID"), windowMin: winMin, assignedTech: tech, assignedRep: tech ? techMap[tech] : undefined });
  }
  slots.sort((a, b) => a.start.localeCompare(b.start));
  return slots;
}

// ---------------------------------------------------------------------
// Customer search / get (dedup + light CRM)
// ---------------------------------------------------------------------
function normCustomer(c: any) {
  return {
    customerID: pickId(c, "customerID", "id"),
    name: [c?.fname, c?.lname].filter(Boolean).join(" ").trim() || c?.companyName || "(no name)",
    phone: String(c?.phone1 ?? c?.phone ?? "").trim(),
    email: String(c?.email ?? "").trim(),
    address: [c?.address, c?.city, c?.state, c?.zip].filter(Boolean).join(", "),
    status: String(c?.status ?? ""),
  };
}
async function customerSearch(officeID: string, q: string) {
  const raw = String(q ?? "").trim();
  if (raw.length < 2) return [];
  const digits = raw.replace(/\D/g, "");
  const filters: Record<string, unknown>[] = [];
  if (digits.length >= 7) filters.push({ phone: digits.slice(-10) });
  if (raw.includes("@")) filters.push({ email: raw });
  if (!filters.length) {
    const parts = raw.split(/\s+/);
    if (parts.length >= 2) filters.push({ fname: parts[0], lname: parts.slice(1).join(" ") });
    else { filters.push({ lname: raw }); filters.push({ fname: raw }); }
  }
  const ids = new Set<string>();
  for (const f of filters) {
    const r = await frTry("customer/search", { officeIDs: officeID, ...f });
    for (const id of (r?.customerIDs ?? []).slice(0, 25)) ids.add(String(id));
    if (ids.size >= 25) break;
  }
  if (!ids.size) return [];
  const got = await frTry("customer/get", { customerIDs: [...ids].slice(0, 25).join(",") });
  return asArray(got?.customers ?? got?.customer).map(normCustomer).filter((c) => c.customerID);
}
async function customerGet(officeID: string, customerID: string) {
  const cRes = await frTry("customer/get", { customerIDs: customerID });
  const customer = normCustomer(asArray(cRes?.customers ?? cRes?.customer)[0] ?? {});
  const sRes = await frTry("subscription/search", { officeIDs: officeID, customerIDs: customerID, includeData: 1 });
  let subs: any[] = asArray(sRes?.subscriptions ?? sRes?.subscription);
  if (!subs.length && Array.isArray(sRes?.subscriptionIDs) && sRes.subscriptionIDs.length) {
    const got = await frTry("subscription/get", { subscriptionIDs: sRes.subscriptionIDs.slice(0, 200).join(",") });
    subs = asArray(got?.subscriptions ?? got?.subscription);
  }
  const subscriptions = subs.map((s: any) => ({
    subscriptionID: pickId(s, "subscriptionID"),
    serviceID: pickId(s, "serviceID"),
    serviceName: s?.serviceType ?? s?.description ?? null,
    active: String(s?.active) === "1",
    frequency: num(s?.frequency),
    serviceCharge: num(s?.serviceCharge),
    initialCharge: num(s?.initialCharge),
    nextService: s?.nextService ?? s?.nextServiceDate ?? null,
    dateAdded: s?.dateAdded ?? null,
  })).filter((s: any) => s.subscriptionID);
  return { customer, subscriptions };
}

// ---------------------------------------------------------------------
// Customer upsert (new sale)
// ---------------------------------------------------------------------
async function upsertCustomer(officeID: string, c: any, warnings: string[]): Promise<string> {
  if (c?.existingCustomerID) return String(c.existingCustomerID);
  const phoneDigits = String(c?.phone ?? "").replace(/\D/g, "");
  for (const filter of [
    phoneDigits.length >= 10 ? { phone: phoneDigits.slice(-10) } : null,
    c?.email?.trim() ? { email: String(c.email).trim() } : null,
  ]) {
    if (!filter) continue;
    const found = await frTry("customer/search", { officeIDs: officeID, ...filter });
    const ids: any[] = found?.customerIDs ?? [];
    if (Array.isArray(ids) && ids.length) { warnings.push("Matched an existing FieldRoutes customer (not duplicated)."); return String(ids[0]); }
  }
  const fname = (c?.firstName ?? "").trim() || String(c?.name ?? "").trim().split(/\s+/)[0] || "Customer";
  const lname = (c?.lastName ?? "").trim() || String(c?.name ?? "").trim().split(/\s+/).slice(1).join(" ") || "-";
  const params: Record<string, unknown> = {
    officeID, fname, lname,
    phone1: phoneDigits || undefined, email: c?.email?.trim() || undefined,
    address: c?.street ?? c?.address ?? undefined, city: c?.city ?? undefined, state: c?.state ?? undefined, zip: c?.zip ?? undefined,
    lat: c?.lat ?? undefined, lng: c?.lng ?? undefined, sourceID: c?.sourceID ?? undefined,
    status: 1, smsReminders: 1,
    notes: c?.sourceLabel ? `Lead source: ${c.sourceLabel}` : undefined,
  };
  const created = await frFetch("customer/create", params);
  const id = pickId(created, "customerID", "result", "id");
  if (!id) throw new Error(`customer/create returned no id: ${JSON.stringify(created).slice(0, 200)}`);
  return id;
}

// ---------------------------------------------------------------------
// Billing profile (best-effort)
// ---------------------------------------------------------------------
async function createPaymentProfile(officeID: string, customerID: string, b: any, warnings: string[]): Promise<{ id?: string; error?: string }> {
  const method = b?.method;
  if (method !== "card" && method !== "ach") return {};
  const isCard = method === "card";
  const params: Record<string, unknown> = {
    officeID, customerID,
    billingName: b?.billingName || undefined, billingAddress1: b?.billingAddress1 || undefined,
    billingCity: b?.billingCity || undefined, billingState: b?.billingState || undefined, billingZip: b?.billingZip || undefined,
    paymentMethod: isCard ? 1 : 2, autopay: b?.autopay ? 1 : 0,
  };
  if (isCard) Object.assign(params, { billingType: 1, cardNumber: String(b?.cardNumber ?? "").replace(/\s/g, ""), expMonth: b?.expMonth, expYear: b?.expYear, cardCode: b?.cvv, cvv: b?.cvv });
  else Object.assign(params, { billingType: 2, accountNumber: b?.accountNumber, routingNumber: b?.routingNumber, checkType: b?.checkType ?? 0, bankName: b?.bankName || undefined });
  let res = await frTry("paymentProfile/create", params);
  if (res?.__error) res = await frTry("customer/createPaymentProfile", params);
  if (res?.__error) { warnings.push(`Billing not saved on the account: ${res.__error}. Use the pay-link so the customer adds their own card.`); return { error: res.__error }; }
  return { id: pickId(res, "paymentProfileID", "billingProfileID", "result", "id") };
}

// ---------------------------------------------------------------------
// Resilient appointment booking — retries so a tight route can't block it.
//   1) pinned spot, service default duration
//   2) pinned spot, short 20-min duration
//   3) unassigned by date (office router places it) — always books
// ---------------------------------------------------------------------
async function bookAppointment(officeID: string, customerID: string, serviceID: string, subscriptionID: string, appt: any) {
  const notes = appt?.notes || "Initial / flush-out service (sold via Growth Sales page)";
  const date = appt?.date || (appt?.start ? String(appt.start).slice(0, 10) : undefined);
  const attempts: Array<{ p: Record<string, unknown>; mode: string }> = [];
  if (appt?.spotID) {
    attempts.push({ mode: "spot", p: { spotID: appt.spotID, rejectOccupiedSpots: 1 } });
    attempts.push({ mode: "spot-short", p: { spotID: appt.spotID, duration: Math.min(20, appt?.windowMin || 20), rejectOccupiedSpots: 1 } });
  }
  if (appt?.start && appt?.end) attempts.push({ mode: "window", p: { start: appt.start, end: appt.end, duration: Math.min(20, appt?.windowMin || 20) } });
  if (date) attempts.push({ mode: "unassigned", p: { date, duration: 20 } });

  let lastErr: string | undefined;
  for (const a of attempts) {
    const p: Record<string, unknown> = {
      officeID, customerID, type: serviceID, subscriptionID,
      employeeID: appt?.employeeID || undefined, notes, ...a.p,
    };
    const res = await frTry("appointment/create", p);
    if (!res?.__error) {
      const id = pickId(res, "appointmentID", "result", "id");
      if (id) return { appointmentID: id, mode: a.mode };
    }
    lastErr = res?.__error;
  }
  return { error: lastErr };
}

// ---------------------------------------------------------------------
// Sell a subscription onto a (already-resolved) customer.
// Shared by "create" (new customer) and "add_service" (existing customer).
// ---------------------------------------------------------------------
async function sellSubscription(officeID: string, customerID: string, body: any, warnings: string[]) {
  const sub = body?.subscription ?? {};
  const billing = body?.billing ?? {};
  const appt = body?.appointment ?? {};
  if (!sub?.serviceID) throw new Error("A plan (serviceID) is required");

  const recurring = num(sub?.serviceCharge) != null && Number(sub.serviceCharge) > 0;
  const frequency = num(sub?.frequencyDays) ?? (recurring ? 90 : -1);
  const subParams: Record<string, unknown> = {
    officeID, customerID, serviceID: sub.serviceID, active: 1, frequency,
    initialCharge: num(sub?.initialCharge) ?? 0,
    serviceCharge: recurring ? Number(sub.serviceCharge) : (num(sub?.initialCharge) ?? 0),
    agreementLength: num(sub?.agreementLengthMonths) ?? undefined,
    soldBy: sub?.soldByEmployeeID ?? undefined,
    poNumber: sub?.poNumber ?? undefined,
  };
  if (Array.isArray(sub?.addons) && sub.addons.length) {
    subParams.subscriptionAddons = sub.addons.map((a: any) => ({ serviceID: a?.serviceID ?? undefined, description: a?.description ?? undefined, amount: num(a?.amount) ?? 0, isRecurring: a?.isRecurring ? 1 : 0 }));
  }
  const subRes = await frFetch("subscription/create", subParams);
  const subscriptionID = pickId(subRes, "subscriptionID", "result", "id");
  if (!subscriptionID) throw new Error(`subscription/create returned no id: ${JSON.stringify(subRes).slice(0, 200)}`);

  // Billing
  let paymentProfileID: string | undefined, billingError: string | undefined;
  const method = billing?.method ?? "paylink";
  if (method === "card" || method === "ach") {
    const pp = await createPaymentProfile(officeID, customerID, billing, warnings);
    paymentProfileID = pp.id; billingError = pp.error;
    if (paymentProfileID && billing?.autopay) {
      const upd = await frTry("subscription/update", { subscriptionID, billToAccountID: paymentProfileID, autopay: 1 });
      if (upd?.__error) warnings.push(`Autopay not linked to the subscription: ${upd.__error}`);
    }
  }

  // Agreement
  let contractSent = false, contractLink: string | undefined, contractError: string | undefined;
  if (body?.agreement?.send !== false) {
    // Per-template extra params (e.g. { documentType: 5 }); empty = default template.
    const cParams = (body?.agreement && typeof body.agreement.contractParams === "object" && body.agreement.contractParams) || {};
    const cRes = await frTry("contract/create", { subscriptionID, emailCustomer: 1, ...cParams });
    if (cRes?.__error) contractError = cRes.__error;
    else { contractSent = true; const link = cRes?.result ?? cRes?.documentLink ?? cRes?.url; if (typeof link === "string" && link.startsWith("http")) contractLink = link; }
  }

  // First appointment (resilient)
  let appointmentID: string | undefined, appointmentError: string | undefined, appointmentMode: string | undefined, assignedRep: string | undefined;
  if (appt?.schedule) {
    const r = await bookAppointment(officeID, customerID, sub.serviceID, subscriptionID, appt);
    if (r.error) appointmentError = r.error;
    else { appointmentID = r.appointmentID; appointmentMode = r.mode; assignedRep = appt?.assignedRep; if (r.mode === "unassigned") warnings.push("Booked as an unassigned appointment on that day — the office router will place it on a route."); }
  }

  return { subscriptionID, method, paymentProfileID, billingError, contractSent, contractLink, contractError, appointmentID, appointmentError, appointmentMode, assignedRep, recurring, frequency };
}

async function logSale(row: Record<string, unknown>) {
  const url = Deno.env.get("SUPABASE_URL"), keyv = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !keyv) return;
  try { await fetch(`${url}/rest/v1/sales_log`, { method: "POST", headers: { "Content-Type": "application/json", apikey: keyv, Authorization: `Bearer ${keyv}`, Prefer: "return=minimal" }, body: JSON.stringify(row) }); } catch { /* best effort */ }
}

async function noteAndLog(officeID: string, customerID: string, body: any, r: any, kind: string) {
  const c = body?.customer ?? {};
  const sub = body?.subscription ?? {};
  const noteText = [
    kind === "add_service" ? "Service added via Growth Sales page" : "Sold via Growth Sales page",
    body?.rep?.name ? `Rep: ${body.rep.name}` : null,
    body?.agreement?.templateName ? `Agreement: ${body.agreement.templateName}` : null,
    c?.sourceLabel ? `Lead source: ${c.sourceLabel}` : null,
    body?.campaign ? `Campaign: ${body.campaign}` : null,
    body?.notes ? `Notes: ${body.notes}` : null,
  ].filter(Boolean).join(" | ");
  await frTry("note/create", { officeID, customerID, notes: noteText, showOnInvoice: 0 });
  await logSale({
    rep_id: body?.rep?.id ?? null, rep_name: body?.rep?.name ?? null, fr_office_id: officeID,
    fr_customer_id: customerID, fr_subscription_id: r.subscriptionID, fr_appointment_id: r.appointmentID ?? null,
    payment_profile_id: r.paymentProfileID ?? null,
    customer_name: [c?.firstName ?? c?.name, c?.lastName].filter(Boolean).join(" ").trim() || null,
    customer_phone: c?.phone ?? null, customer_email: c?.email ?? null,
    address: [c?.street ?? c?.address, c?.city, c?.state, c?.zip].filter(Boolean).join(", ") || null,
    plan_service_id: String(sub.serviceID), initial_charge: num(sub?.initialCharge),
    service_charge: r.recurring ? Number(sub.serviceCharge) : null, frequency_days: r.frequency,
    agreement_length_months: num(sub?.agreementLengthMonths), billing_method: r.method,
    contract_sent: r.contractSent, lead_source: c?.sourceLabel ?? null, campaign: body?.campaign ?? null,
    notes: body?.notes ?? null, status: kind === "add_service" ? "service_added" : "sold",
  });
}

function saleResponse(customerID: string, r: any, warnings: string[]) {
  return {
    ok: true, customerID, subscriptionID: r.subscriptionID,
    paymentProfileID: r.paymentProfileID ?? null, billingMethod: r.method, billingError: r.billingError ?? null,
    payLinkUrl: (r.method === "paylink" || r.billingError) ? frPortalUrl() : null,
    contractSent: r.contractSent, contractLink: r.contractLink ?? null, contractError: r.contractError ?? null,
    appointmentID: r.appointmentID ?? null, appointmentError: r.appointmentError ?? null, appointmentMode: r.appointmentMode ?? null,
    assignedRep: r.assignedRep ?? null, warnings,
  };
}

// ---------------------------------------------------------------------
async function createSale(body: any) {
  const officeID = String(body?.officeID ?? DEFAULT_OFFICE);
  const warnings: string[] = [];
  const c = body?.customer ?? {};
  if (!c?.firstName && !c?.name && !c?.existingCustomerID) throw new Error("Customer name is required");
  const customerID = await upsertCustomer(officeID, c, warnings);
  const r = await sellSubscription(officeID, customerID, body, warnings);
  await noteAndLog(officeID, customerID, body, r, "create");
  return saleResponse(customerID, r, warnings);
}
async function addService(body: any) {
  const officeID = String(body?.officeID ?? DEFAULT_OFFICE);
  const customerID = String(body?.customerID ?? body?.customer?.existingCustomerID ?? "");
  if (!customerID) throw new Error("customerID is required for add_service");
  const warnings: string[] = [];
  const r = await sellSubscription(officeID, customerID, body, warnings);
  await noteAndLog(officeID, customerID, body, r, "add_service");
  return saleResponse(customerID, r, warnings);
}

// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// GoHighLevel leads (Pestkee) — Facebook + Thumbtack high-intent leads
// ---------------------------------------------------------------------
const GHL_BASE = "https://services.leadconnectorhq.com";
async function getSecret(name: string): Promise<string | null> {
  const env = Deno.env.get(name); if (env) return env;
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  try {
    const r = await fetch(`${url}/rest/v1/rpc/get_secret`, { method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ p_name: name }) });
    if (!r.ok) return null;
    const d = await r.json(); return typeof d === "string" ? d : (Array.isArray(d) ? (d[0] ?? null) : (d ?? null));
  } catch { return null; }
}
async function ghlToken(): Promise<string> {
  const t = (await getSecret("GHL_TOKEN_PEST_CONTROL")) || (await getSecret("GHL_TOKEN"));
  if (!t) throw new Error("GHL token not configured (GHL_TOKEN_PEST_CONTROL / GHL_TOKEN)");
  return t;
}
async function ghlLoc(): Promise<string> { return (await getSecret("GHL_LOCATION_ID")) || "z4t41ywW9EayYdtYsUBH"; }
async function ghlGet(path: string, version = "2021-07-28"): Promise<any> {
  const token = await ghlToken();
  const r = await fetch(`${GHL_BASE}${path}`, { headers: { Authorization: `Bearer ${token}`, Version: version, Accept: "application/json" } });
  const t = await r.text(); let d: any = {}; try { d = t ? JSON.parse(t) : {}; } catch { d = { raw: t }; }
  if (!r.ok) throw new Error(`GHL ${path} -> ${r.status}: ${JSON.stringify(d).slice(0, 300)}`);
  return d;
}
function channelOf(source: string, tags: string[]): string {
  const s = (source || "").toLowerCase(); const tl = tags.map((t) => String(t).toLowerCase());
  if (s.includes("thumbtack") || tl.some((t) => t.includes("thumbtack"))) return "Thumbtack";
  if (/face|fb|meta|instagram/.test(s) || tl.some((t) => /facebook|meta|instagram/.test(t))) return "Facebook";
  return source || "Other";
}
// Flatten GHL/Thumbtack custom-field values (which can be nested objects/arrays
// of {question,answer} / {label,value}) into readable text.
function flattenVal(v: any): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(flattenVal).filter((x) => x.trim()).join("\n");
  if (typeof v === "object") {
    const q = v.question ?? v.label ?? v.name ?? v.key ?? v.title;
    const a = v.answer ?? v.answers ?? v.value ?? v.text ?? v.response;
    if (q != null || a != null) { const av = flattenVal(a); return `${q != null ? String(q) + ": " : ""}${av}`.trim(); }
    return JSON.stringify(v);
  }
  return String(v);
}
const CUSTOMER_TAGS = ["pestkee-active", "pestkee-paused", "pestkee-inactive"];
// The GHL location is shared across all Advosy brands, so a contact only
// belongs on the Pestkee sales page if it carries a Pestkee brand signal in
// its tags or source (e.g. "pestkee thumbtack", "Pestkee Website Contact Form").
function isPestkeeLead(source: string, tags: string[]): boolean {
  const hay = [source ?? "", ...(tags ?? [])].join(" ").toLowerCase();
  return hay.includes("pestkee");
}
async function getLeads(limit = 60) {
  const loc = await ghlLoc();
  const data = await ghlGet(`/contacts/?locationId=${loc}&limit=100`);
  const contacts = asArray(data?.contacts);
  contacts.sort((a: any, b: any) => String(b?.dateAdded ?? "").localeCompare(String(a?.dateAdded ?? "")));
  const out = [];
  for (const c of contacts) {
    const tags = (c?.tags ?? []).map(String);
    if (!isPestkeeLead(c?.source, tags)) continue;               // Pestkee only
    if (tags.some((t: string) => CUSTOMER_TAGS.includes(t.toLowerCase()))) continue;
    out.push({
      contactId: c?.id,
      name: [c?.firstName, c?.lastName].filter(Boolean).join(" ") || c?.contactName || c?.name || "(no name)",
      firstName: c?.firstName || "", lastName: c?.lastName || "",
      phone: c?.phone || "", email: c?.email || "",
      street: c?.address1 || "", city: c?.city || "", state: c?.state || "", zip: c?.postalCode || "",
      source: c?.source || "", channel: channelOf(c?.source, tags), dateAdded: c?.dateAdded || null, tags,
    });
    if (out.length >= limit) break;
  }
  return out;
}
async function getLeadDetail(contactId: string) {
  const loc = await ghlLoc();
  const [detail, defsRes, notesRes] = await Promise.all([
    ghlGet(`/contacts/${contactId}`),
    ghlGet(`/locations/${loc}/customFields`).catch(() => ({})),
    ghlGet(`/contacts/${contactId}/notes`).catch(() => ({})),
  ]);
  const c = detail?.contact ?? {};
  const defs: Record<string, string> = {};
  for (const f of asArray(defsRes?.customFields)) { if (f?.id) defs[f.id] = f?.name || f?.fieldKey || f.id; }
  const answers: { label: string; value: string }[] = [];
  for (const cf of asArray(c?.customFields ?? c?.customField)) {
    const val = flattenVal(cf?.value);
    if (val && val.trim() !== "") answers.push({ label: defs[cf?.id] || cf?.id || "Field", value: val.trim() });
  }
  const notes = asArray(notesRes?.notes).map((n: any) => String(n?.body ?? "").trim()).filter(Boolean);
  const tags = (c?.tags ?? []).map(String);
  return {
    contactId, name: [c?.firstName, c?.lastName].filter(Boolean).join(" ") || c?.contactName || "",
    firstName: c?.firstName || "", lastName: c?.lastName || "", phone: c?.phone || "", email: c?.email || "",
    street: c?.address1 || "", city: c?.city || "", state: c?.state || "", zip: c?.postalCode || "",
    source: c?.source || "", channel: channelOf(c?.source, tags), dateAdded: c?.dateAdded || null, tags,
    answers, notes,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const action = body?.action ?? "options";
    const officeID = String(body?.officeID ?? DEFAULT_OFFICE);

    if (action === "options") return json(await getOptions(officeID));
    if (action === "availability") {
      const now = Date.now();
      const start = body?.start_date != null ? (typeof body.start_date === "number" ? body.start_date : Date.parse(body.start_date)) : now;
      const end = body?.end_date != null ? (typeof body.end_date === "number" ? body.end_date : Date.parse(body.end_date)) : now + 14 * 86400000;
      const slots = await getAvailability(officeID, start, end, num(body?.default_duration_min) ?? 45);
      return json({ officeID, count: slots.length, slots });
    }
    if (action === "leads") return json({ leads: await getLeads(num(body?.limit) ?? 60) });
    if (action === "lead_get") {
      if (!body?.contactId) return json({ error: "contactId required" }, 400);
      return json(await getLeadDetail(String(body.contactId)));
    }
    if (action === "customer_search") return json({ results: await customerSearch(officeID, body?.q ?? body?.query ?? "") });
    if (action === "customer_get") {
      if (!body?.customerID) return json({ error: "customerID required" }, 400);
      return json(await customerGet(officeID, String(body.customerID)));
    }
    if (action === "create") return json(await createSale(body));
    if (action === "add_service") return json(await addService(body));

    return json({ error: `Unknown action "${action}"` }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
