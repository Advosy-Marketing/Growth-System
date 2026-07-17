// =====================================================================
// Drive-time guard (optional). Active only when MAPS_API_KEY is set.
// Most valuable on GHL lines, which are otherwise location-blind.
//
// To finish wiring it (after choosing Google or Mapbox):
//   1. Implement travelTimeMinutes() with the chosen matrix API.
//   2. In filterByDriveTime(), for each slot look up the candidate rep's
//      appointments immediately before/after the slot, geocode the
//      addresses (cache in the geocode_cache table), and drop slots where
//      gap < serviceDuration + travel + cfg.drive_buffer_min.
// =====================================================================

import type { Slot, ServiceConfig } from "./providers.ts";

export function driveTimeEnabled(): boolean {
  return !!Deno.env.get("MAPS_API_KEY");
}

// Returns driving minutes between two addresses via the configured maps provider.
export async function travelTimeMinutes(_fromAddr: string, _toAddr: string): Promise<number> {
  const provider = Deno.env.get("MAPS_PROVIDER") ?? "google";
  throw new Error(`travelTimeMinutes not implemented for MAPS_PROVIDER="${provider}". Wire Google Distance Matrix or Mapbox Matrix here.`);
}

// Pass-through until travelTimeMinutes is implemented. Keeps availability working today.
export async function filterByDriveTime(slots: Slot[], _cfg: ServiceConfig): Promise<Slot[]> {
  if (!driveTimeEnabled()) return slots;
  // Real implementation goes here (see header). For now, no-op so realtime
  // availability is unaffected until the matrix call is plugged in.
  return slots;
}
