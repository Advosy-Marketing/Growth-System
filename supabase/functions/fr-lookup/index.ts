// =====================================================================
// POST /functions/v1/fr-lookup
// One-off discovery helper: pulls FieldRoutes offices, service types,
// customer sources, and employees so service_catalog (fr_office_id,
// fr_service_type_id) and channel->sourceID mapping can be configured.
// Requires FR_SUBDOMAIN / FR_AUTH_KEY / FR_AUTH_TOKEN secrets.
// Body (optional):
//   { officeID?: string }        — scope lookups to one office.
//   { spotsOfficeID?: string, spotsDays?: number } — ALSO run spot/search
//     for the next N days (default 7) and summarize open/API-schedulable spots.
// =====================================================================

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

async function frFetch(action: string, params: Record<string, unknown>): Promise<any> {
  const sub = Deno.env.get("FR_SUBDOMAIN"), key = Deno.env.get("FR_AUTH_KEY"), token = Deno.env.get("FR_AUTH_TOKEN");
  if (!sub || !key || !token) throw new Error("Set FR_SUBDOMAIN, FR_AUTH_KEY, FR_AUTH_TOKEN secrets first");
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    body.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  body.append("authenticationKey", key);
  body.append("authenticationToken", token);
  const res = await fetch(`https://${sub}.fieldroutes.com/api/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body: body.toString(),
  });
  const text = await res.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : { raw: text }; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`FieldRoutes ${action} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return data;
}

async function tryLookup(action: string, params: Record<string, unknown>): Promise<unknown> {
  try { return await frFetch(action, { ...params, includeData: 1 }); }
  catch (e) { return { error: String((e as Error)?.message ?? e) }; }
}

function ymd(msOffset: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Phoenix", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + msOffset));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const officeID = body?.officeID ? String(body.officeID) : undefined;
    const scope = officeID ? { officeIDs: officeID } : {};

    // Spot-availability probe (used to verify AI-setter bookability)
    if (body?.spotsOfficeID) {
      const days = Number(body.spotsDays ?? 7);
      const data = await tryLookup("spot/search", {
        officeIDs: String(body.spotsOfficeID),
        date: { operator: "BETWEEN", value: [ymd(0), ymd(days * 86_400_000)] },
        apiCanSchedule: 1,
      }) as any;
      let spots: any[] = data?.spots ?? data?.spot ?? [];
      if (!Array.isArray(spots)) spots = [spots].filter(Boolean);
      const open = spots.filter((s) => {
        const taken = s?.currentAppointment || s?.appointmentID || s?.currentAppointmentID;
        const reserved = String(s?.reserved ?? "0") === "1";
        const blocked = String(s?.blockReason ?? "").trim() !== "" || String(s?.isBlocked ?? "0") === "1";
        return !(taken && String(taken) !== "0") && !reserved && !blocked;
      });
      return json({
        window: [ymd(0), ymd(days * 86_400_000)],
        totalSpotIDs: Array.isArray(data?.spotIDs) ? data.spotIDs.length : null,
        spotsResolved: spots.length,
        openSpots: open.length,
        sampleOpen: open.slice(0, 5).map((s: any) => ({ date: s?.date, start: s?.start ?? s?.startTime, end: s?.end ?? s?.endTime, tech: s?.assignedTech, spotID: s?.spotID })),
        error: data?.error ?? null,
        rawKeys: data && typeof data === "object" ? Object.keys(data).slice(0, 15) : null,
      });
    }

    const [offices, serviceTypes, sources, employees] = await Promise.all([
      tryLookup("office/search", {}),
      tryLookup("serviceType/search", scope),
      tryLookup("customerSource/search", scope),
      tryLookup("employee/search", { ...scope, active: 1 }),
    ]);

    return json({ offices, serviceTypes, sources, employees });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
