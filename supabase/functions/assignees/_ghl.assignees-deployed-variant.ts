// =====================================================================
// GoHighLevel (v2) adapter — assignee listing slice for the booking app.
// =====================================================================

import type { ServiceConfig } from "./providers.ts";
import { admin } from "./db.ts";

const BASE = "https://services.leadconnectorhq.com";
const CAL_VERSION = "2021-04-15";
const CONTACT_VERSION = "2021-07-28";

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

async function ghlUserName(token: string, userId: string): Promise<string> {
  try {
    const u = await ghlFetch(token, `/users/${userId}`, CONTACT_VERSION);
    const usr = u?.user ?? u ?? {};
    const name = usr.name || [usr.firstName, usr.lastName].filter(Boolean).join(" ").trim();
    return name || userId;
  } catch (_) {
    return userId;
  }
}

export async function listGhlAssignees(cfg: ServiceConfig): Promise<{ id: string; name: string }[]> {
  if (cfg.provider !== "ghl" || !cfg.ghl_calendar_id) return [];
  const token = await tokenFor(cfg.service_type);
  const { teamUserIds } = await getCalendar(token, cfg.ghl_calendar_id);
  const reps = await Promise.all(
    teamUserIds.map(async (id) => ({ id, name: await ghlUserName(token, id) })),
  );
  return reps.sort((a, b) => a.name.localeCompare(b.name));
}
