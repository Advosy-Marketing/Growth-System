// =====================================================================
// ServiceTitan adapter — Heating & Air + Plumbing (Everest)
// =====================================================================

import type { AvailabilityProvider, ServiceConfig, Slot, BookingInput, BookingResult } from "./providers.ts";
import { admin } from "./db.ts";

const ENV = Deno.env.get("ST_ENV") ?? "production";
const AUTH_BASE = ENV === "integration" ? "https://auth-integration.servicetitan.io" : "https://auth.servicetitan.io";
const API_BASE = ENV === "integration" ? "https://api-integration.servicetitan.io" : "https://api.servicetitan.io";

async function secret(name: string): Promise<string> {
  const env = Deno.env.get(name);
  if (env) return env;
  const { data, error } = await admin().rpc("get_secret", { p_name: name });
  if (error || !data) throw new Error(`Missing ServiceTitan secret ${name} (set env or Vault secret '${name}')`);
  return data as string;
}

let tokenCache: { token: string; exp: number } | null = null;
async function getToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.exp) return tokenCache.token;
  const [clientId, clientSecret] = await Promise.all([secret("ST_CLIENT_ID"), secret("ST_CLIENT_SECRET")]);
  const res = await fetch(`${AUTH_BASE}/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`ServiceTitan auth → ${res.status}: ${JSON.stringify(body)}`);
  tokenCache = { token: body.access_token, exp: Date.now() + ((body.expires_in ?? 900) - 60) * 1000 };
  return tokenCache.token;
}

async function stFetch(path: string, init: RequestInit = {}) {
  const [token, appKey] = await Promise.all([getToken(), secret("ST_APP_KEY")]);
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${token}`,
      "ST-App-Key": appKey,
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let b: any = {};
  try { b = text ? JSON.parse(text) : {}; } catch { b = { raw: text }; }
  if (!res.ok) throw new Error(`ServiceTitan ${init.method ?? "GET"} ${path} → ${res.status}: ${JSON.stringify(b)}`);
  return b;
}

function tzOffsetMs(tz: string, atMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(atMs))) p[part.type] = part.value;
  let h = Number(p.hour); if (h === 24) h = 0;
  const asIfUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), h, Number(p.minute), Number(p.second));
  return asIfUTC - atMs;
}
function stLocalToUTC(s: string | undefined, tz: string): string | undefined {
  if (!s) return s;
  const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return s;
  const naiveUTC = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  let off = tzOffsetMs(tz, naiveUTC);
  off = tzOffsetMs(tz, naiveUTC - off);
  return new Date(naiveUTC - off).toISOString();
}

export const serviceTitanProvider: AvailabilityProvider = {
  async getAvailability(cfg, startMs, endMs, timezone) {
    const tz = (Deno.env.get("ST_TZ") || timezone || "America/Phoenix");
    const tenantId = await secret("ST_TENANT_ID");
    const body: Record<string, unknown> = {
      startsOnOrAfter: new Date(startMs).toISOString(),
      endsOnOrBefore: new Date(endMs).toISOString(),
      businessUnitIds: cfg.st_business_unit_id ? [Number(cfg.st_business_unit_id)] : [],
      skillBasedAvailability: true,
    };
    if (cfg.st_job_type_id) body.jobTypeId = Number(cfg.st_job_type_id);

    const data = await stFetch(`/dispatch/v2/tenant/${tenantId}/capacity`, { method: "POST", body: JSON.stringify(body) });
    const out: Slot[] = [];
    for (const a of (data?.availabilities ?? [])) {
      if (a?.isAvailable === false) continue;
      out.push({ start: stLocalToUTC(a.start, tz)!, end: stLocalToUTC(a.end, tz)! });
    }
    return out;
  },

  async createBooking(cfg, input) {
    const tenantId = await secret("ST_TENANT_ID");
    const providerId = await secret("ST_BOOKING_PROVIDER_ID");
    const head = [`${cfg.label} — ${input.appointmentType}`];
    if (input.emergency) head.push("⚠ EMERGENCY");
    if (input.gateCode) head.push(`Gate code: ${input.gateCode}`);
    if (input.channel) head.push(`Source: ${input.channel}`);
    if (input.campaign) head.push(`Campaign: ${input.campaign}`);
    const summary = head.join(" · ") + (input.notes ? `\n\nLead notes: ${input.notes}` : "");
    function parseAddress(a: string) {
      const parts = (a || "").split(",").map((s) => s.trim()).filter(Boolean);
      let street = "", city = "", state = "", zip = "";
      if (parts.length) {
        street = parts[0] || "";
        const last = parts[parts.length - 1] || "";
        const m = last.match(/([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?$/);
        if (m) { state = m[1].toUpperCase(); zip = m[2]; city = parts.length >= 3 ? (parts[parts.length - 2] || "") : (parts[1] || ""); }
        else { city = parts[1] || ""; }
      }
      return { street, city, state, zip };
    }
    const c = input.customer;
    const addr = (c.street && c.city && c.state && c.zip)
      ? { street: c.street, city: c.city, state: String(c.state).toUpperCase(), zip: c.zip }
      : parseAddress(c.address || "");
    const body: Record<string, unknown> = {
      source: "Advosy Growth",
      name: input.customer.name,
      externalId: `advosy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      summary,
      isFirstTimeClient: true,
      start: input.slot.start,
      priority: input.emergency ? "Urgent" : "Normal",
      contacts: [
        input.customer.phone ? { type: "Phone", value: input.customer.phone } : null,
        input.customer.email ? { type: "Email", value: input.customer.email } : null,
      ].filter(Boolean),
    };
    if (cfg.st_business_unit_id) body.businessUnitId = Number(cfg.st_business_unit_id);
    if (cfg.st_job_type_id) body.jobTypeId = Number(cfg.st_job_type_id);
    if (input.campaignId) body.campaignId = Number(input.campaignId);
    if (addr.street && addr.city && addr.state && addr.zip) {
      body.address = { street: addr.street, city: addr.city, state: addr.state, zip: addr.zip, country: "USA" };
    }

    const data = await stFetch(`/crm/v2/tenant/${tenantId}/booking-provider/${providerId}/bookings`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const id = data?.id ?? data?.bookingId;
    if (!id) throw new Error(`ServiceTitan booking returned no id: ${JSON.stringify(data)}`);
    return { providerRef: String(id), assignedRep: "ServiceTitan (pending office confirmation)", status: "booked" };
  },
};
