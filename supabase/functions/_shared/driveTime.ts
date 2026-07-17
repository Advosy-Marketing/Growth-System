// =====================================================================
// Drive-time guard (optional). Active only when MAPS_API_KEY is set.
// =====================================================================

import type { Slot, ServiceConfig } from "./providers.ts";

export function driveTimeEnabled(): boolean {
  return !!Deno.env.get("MAPS_API_KEY");
}

export async function travelTimeMinutes(_fromAddr: string, _toAddr: string): Promise<number> {
  const provider = Deno.env.get("MAPS_PROVIDER") ?? "google";
  throw new Error(`travelTimeMinutes not implemented for MAPS_PROVIDER="${provider}". Wire Google Distance Matrix or Mapbox Matrix here.`);
}

// Pass-through until travelTimeMinutes is implemented.
export async function filterByDriveTime(slots: Slot[], _cfg: ServiceConfig): Promise<Slot[]> {
  if (!driveTimeEnabled()) return slots;
  return slots;
}
