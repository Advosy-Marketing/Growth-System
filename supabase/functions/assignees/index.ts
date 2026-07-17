// =====================================================================
// POST /functions/v1/assignees
// Body: { service_type }
// Returns the service line's assignable reps for the "Assign to" dropdown.
//   { service_type, provider, assignees: [{ id, name }] }
// Only GHL lines (roofing / restoration) return a team; every other
// provider returns an empty list (they use their own dispatch/route logic),
// which the UI reads as "auto-assign only, no manual picker".
// =====================================================================

import { admin, getServiceConfig } from "../_shared/db.ts";
import { listGhlAssignees } from "../_shared/ghl.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { service_type } = await req.json();
    if (!service_type) return json({ error: "service_type is required" }, 400);

    const db = admin();
    const cfg = await getServiceConfig(db, service_type);
    if (cfg.provider !== "ghl") return json({ service_type, provider: cfg.provider, assignees: [] });

    const assignees = await listGhlAssignees(cfg);
    return json({ service_type, provider: cfg.provider, assignees });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
