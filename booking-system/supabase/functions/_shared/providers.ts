// =====================================================================
// Shared types + the interface every backend adapter implements.
// One interface, three backends (ServiceTitan / GHL / FieldRoutes).
// =====================================================================

export type Provider = "servicetitan" | "ghl" | "fieldroutes";
export type ServiceType = "hvac" | "plumbing" | "roofing" | "restoration" | "pest_control";
export type AppointmentType = "inspection" | "maintenance" | "repair_replace" | "onsite_estimate";

export interface Slot {
  start: string;            // ISO 8601 with offset, e.g. 2026-06-20T09:00:00-07:00
  end: string;              // ISO 8601
  assignedRep?: string;     // tech/user name if known
  assignedUserId?: string;  // backend user id (used to pin a drive-time-validated rep)
  ref?: string;             // provider-specific opaque reference
}

export interface CustomerInput {
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  street?: string;   // structured address (preferred for ServiceTitan)
  city?: string;
  state?: string;
  zip?: string;
}

export interface BookingInput {
  serviceType: ServiceType;
  appointmentType: AppointmentType;
  customer: CustomerInput;
  slot: Slot;
  assignedUserId?: string;  // pin a specific rep (e.g. after drive-time validation)
  notes?: string;           // lead notes from the rep -> booking summary
  gateCode?: string;
  emergency?: boolean;
  channel?: string;         // readable lead source/channel (e.g. "LSA (Local Services Ads)")
  campaign?: string;        // readable Growth campaign (e.g. "Demand Generation")
  campaignId?: string;      // ServiceTitan marketing campaign id (attribution), when mapped
}

export interface BookingResult {
  providerRef: string;
  assignedRep?: string;
  status: "booked" | "failed";
  error?: string;
}

// One row of service_catalog (the routing + config table).
export interface ServiceConfig {
  service_type: ServiceType;
  label: string;
  provider: Provider;
  ghl_location_id?: string;
  ghl_calendar_id?: string;
  st_business_unit_id?: string;
  st_job_type_id?: string;
  fr_office_id?: string;
  fr_service_type_id?: string;
  default_duration_min: number;
  drive_buffer_min: number;
}

export interface AvailabilityProvider {
  getAvailability(cfg: ServiceConfig, startMs: number, endMs: number, timezone: string): Promise<Slot[]>;
  createBooking(cfg: ServiceConfig, input: BookingInput): Promise<BookingResult>;
}
