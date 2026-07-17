// =====================================================================
// POST /functions/v1/availability
// Body: { service_type, start_date, end_date, timezone? }
//   start_date/end_date: epoch ms (number) or ISO date string
// Returns normalized slots for the service line's backend.
// =====================================================================

import { admin, getServiceConfig } from "../_shared/db.ts";
import { ghlProvider } from "../_shared/ghl.ts";
import { serviceTitanProvider } from "../_shared/servicetitan.ts";
import { frProvider } from "../_shared/fieldroutes.ts";
import { filterByDriveTime } from "../_shared/driveTime.ts";
import type { AvailabilityProvider, Provider } from "../_shared/providers.ts";

const PROVIDERS: Partial<Record<Provider, AvailabilityProvider>> = {
  ghl: ghlProvider,
  servicetitan: serviceTitanProvider,
  fieldroutes: frProvider,
};

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
    const { service_type, start_date, end_date, timezone, job_type_id, business_unit_id } = await req.json();
    if (!service_type || start_date == null || end_date == null) {
      return json({ error: "service_type, start_date, end_date are required" }, 400);
    }

    const db = admin();
    const cfg = await getServiceConfig(db, service_type);
    // Per-request override: a specific ServiceTitan job type / business unit (the two-tier picker).
    if (job_type_id) cfg.st_job_type_id = String(job_type_id);
    if (business_unit_id) cfg.st_business_unit_id = String(business_unit_id);
    const provider = PROVIDERS[cfg.provider];
    if (!provider) return json({ error: `Provider "${cfg.provider}" not wired yet` }, 501);

    const tz = timezone || "America/Phoenix";
    const startMs = typeof start_date === "number" ? start_date : Date.parse(start_date);
    const endMs = typeof end_date === "number" ? end_date : Date.parse(end_date);

    let slots = await provider.getAvailability(cfg, startMs, endMs, tz);
    slots = await filterByDriveTime(slots, cfg);

    return json({ service_type, provider: cfg.provider, count: slots.length, slots });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
