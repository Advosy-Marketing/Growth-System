// =====================================================================
// POST /functions/v1/fr-lookup
// One-off discovery helper: pulls FieldRoutes offices, service types,
// customer sources, and employees so service_catalog (fr_office_id,
// fr_service_type_id) and channel->sourceID mapping can be configured.
// Requires FR_SUBDOMAIN / FR_AUTH_KEY / FR_AUTH_TOKEN secrets.
// Body (optional): { officeID?: string }  — scope lookups to one office.
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

// search (IDs + includeData) with graceful failure per resource
async function tryLookup(action: string, params: Record<string, unknown>): Promise<unknown> {
  try { return await frFetch(action, { ...params, includeData: 1 }); }
  catch (e) { return { error: String((e as Error)?.message ?? e) }; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const officeID = body?.officeID ? String(body.officeID) : undefined;
    const scope = officeID ? { officeIDs: officeID } : {};

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
