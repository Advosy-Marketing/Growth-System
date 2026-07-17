// =====================================================================
// POST /functions/v1/rep-availability
// Body: { service_type, start_date, end_date, timezone?, assigned_user_id }
// GHL-only. Returns free slots for ONE rep's calendar (or the whole calendar
// when assigned_user_id is omitted). Self-contained: no _shared imports.
// =====================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

const BASE = "https://services.leadconnectorhq.com";
const CAL_VERSION = "2021-04-15";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function admin() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

async function tokenFor(db: any, serviceType: string): Promise<string> {
  const svc = serviceType.toUpperCase();
  const envPer = Deno.env.get(`GHL_TOKEN_${svc}`);
  if (envPer) return envPer;
  const vaultPer = await db.rpc("get_secret", { p_name: `GHL_TOKEN_${svc}` });
  if (!vaultPer.error && vaultPer.data) return vaultPer.data as string;
  const envShared = Deno.env.get("GHL_TOKEN");
  if (envShared) return envShared;
  const { data, error } = await db.rpc("get_secret", { p_name: "GHL_TOKEN" });
  if (error || !data) throw new Error(`No GHL token for ${serviceType}: set GHL_TOKEN_${svc} or GHL_TOKEN`);
  return data as string;
}

async function ghlFetch(token: string, path: string, version: string) {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Version": version,
      "Accept": "application/json",
      "Content-Type": "application/json",
    },
  });
  const text = await res.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) throw new Error(`GHL GET ${path} -> ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function calendarDuration(token: string, calendarId: string): Promise<number | null> {
  const data = await ghlFetch(token, `/calendars/${calendarId}`, CAL_VERSION);
  const cal = data?.calendar ?? {};
  if (typeof cal.slotDuration === "number" && cal.slotDuration > 0) {
    const unit = String(cal.slotDurationUnit ?? "mins").toLowerCase();
    return unit.startsWith("hour") ? cal.slotDuration * 60 : cal.slotDuration;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { service_type, start_date, end_date, timezone, assigned_user_id } = await req.json();
    if (!service_type || start_date == null || end_date == null) {
      return json({ error: "service_type, start_date, end_date are required" }, 400);
    }

    const db = admin();
    const { data: cfg, error } = await db.from("service_catalog").select("*").eq("service_type", service_type).single();
    if (error || !cfg) return json({ error: `No service_catalog row for ${service_type}` }, 404);
    if (cfg.provider !== "ghl") return json({ error: "rep-availability supports GHL lines only" }, 400);
    if (!cfg.ghl_calendar_id) return json({ error: `ghl_calendar_id empty for ${service_type}` }, 400);

    const tz = timezone || "America/Phoenix";
    const startMs = typeof start_date === "number" ? start_date : Date.parse(start_date);
    const endMs = typeof end_date === "number" ? end_date : Date.parse(end_date);

    const token = await tokenFor(db, cfg.service_type);
    const durMin = (await calendarDuration(token, cfg.ghl_calendar_id)) ?? cfg.default_duration_min;

    const qs = new URLSearchParams({ startDate: String(startMs), endDate: String(endMs), timezone: tz });
    if (assigned_user_id) qs.set("userId", assigned_user_id);

    const data = await ghlFetch(token, `/calendars/${cfg.ghl_calendar_id}/free-slots?${qs}`, CAL_VERSION);
    const slots: { start: string; end: string }[] = [];
    for (const [key, val] of Object.entries<any>(data)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
      for (const start of (val?.slots ?? [])) {
        const end = new Date(new Date(start).getTime() + durMin * 60000).toISOString();
        slots.push({ start, end });
      }
    }
    return json({ service_type, provider: "ghl", count: slots.length, assigned_user_id: assigned_user_id ?? null, slots });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
