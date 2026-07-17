// =====================================================================
// Local smoke test — prove the GoHighLevel connection returns REAL,
// realtime slots, without deploying anything.
//
// Run from the booking-system/ folder:
//
//   GHL_TOKEN_ROOFING="pit-xxxxxxxx" \
//   GHL_CAL="<roofing calendarId>" \
//   GHL_LOC="<roofing locationId>" \
//   deno run --allow-net --allow-env scripts/test-ghl.ts
//
// (Use GHL_TOKEN_RESTORATION + that calendar/location to test restoration —
//  just change SERVICE below to "restoration".)
// =====================================================================

import { ghlProvider } from "../supabase/functions/_shared/ghl.ts";

const SERVICE = "roofing"; // matches GHL_TOKEN_ROOFING

const cfg = {
  service_type: SERVICE,
  label: "Roofing",
  provider: "ghl",
  ghl_calendar_id: Deno.env.get("GHL_CAL")!,
  ghl_location_id: Deno.env.get("GHL_LOC")!,
  default_duration_min: 90,
  drive_buffer_min: 15,
} as any;

if (!cfg.ghl_calendar_id || !cfg.ghl_location_id) {
  console.error("Set GHL_CAL and GHL_LOC env vars (and GHL_TOKEN_ROOFING).");
  Deno.exit(1);
}

const now = Date.now();
const sevenDays = now + 7 * 24 * 60 * 60 * 1000;

console.log(`Fetching real availability from GoHighLevel for "${SERVICE}"…\n`);
const slots = await ghlProvider.getAvailability(cfg, now, sevenDays, "America/Phoenix");

console.log(`✓ Got ${slots.length} real open slots. First few:`);
for (const s of slots.slice(0, 10)) console.log("   ", s.start, "→", s.end);
if (slots.length === 0) console.log("   (none — check the calendar has availability configured)");
