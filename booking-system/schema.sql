-- =====================================================================
-- Advosy Growth — Unified Booking System
-- Supabase / Postgres schema + seed
-- Generated: 2026-06-17
--
-- Apply with the Supabase SQL editor, the Supabase CLI
-- (`supabase db push`), or paste into a new migration.
-- Secrets (ServiceTitan / GHL / FieldRoutes credentials) belong in
-- Supabase Vault, NOT in these tables — see provider_credentials note.
-- =====================================================================

-- ---------- Extensions ----------
create extension if not exists "pgcrypto";   -- gen_random_uuid()

-- =====================================================================
-- ENUMS
-- =====================================================================

-- Which Growth team booked it
create type source_type as enum ('inbound', 'outbound');

-- Which backend holds the appointment
create type provider_type as enum ('servicetitan', 'ghl', 'fieldroutes');

-- Service lines (brand in parentheses): hvac/plumbing=Everest,
-- roofing=VRZA, restoration=Bloque, pest_control=Pestkee
create type service_type as enum (
  'hvac', 'plumbing', 'roofing', 'restoration', 'pest_control'
);

-- The decision-tree result
create type appointment_type as enum (
  'inspection', 'maintenance', 'repair_replace', 'onsite_estimate'
);

-- Lead channel dropdown. 'other' pairs with channel_other free text.
create type channel_type as enum (
  'meta_ads', 'lsa', 'thumbtack', 'outbound_calling', 'organic_social',
  'jobsite_marketing', 'eddm', 'b2b_affiliate', 'other'
);

-- The 5 overarching campaigns. 'other' pairs with campaign_other free text.
create type campaign_type as enum (
  'demand_generation', 'high_intent', 'we_are_advosy',
  'sales_enablement', 'brand_awareness', 'other'
);

create type booking_status as enum ('booked', 'failed', 'cancelled');

-- =====================================================================
-- app_users  (rep profile layered on Supabase auth.users)
-- =====================================================================
create table app_users (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text not null,
  team        source_type,                 -- which team this rep sits on
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);
comment on table app_users is 'Growth reps who use the booking app; 1:1 with auth.users.';

-- =====================================================================
-- customers  (entered ONCE per booking session, reused for every service)
-- =====================================================================
create table customers (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  phone         text,
  email         text,
  address       text,                       -- service address
  lat           double precision,           -- geocoded once, reused for drive-time checks
  lng           double precision,
  external_refs jsonb not null default '{}'::jsonb,  -- {servicetitan_customer_id, ghl_contact_id, fieldroutes_customer_id}
  created_by    uuid references app_users (id),
  created_at    timestamptz not null default now()
);
comment on column customers.external_refs is 'IDs of this customer in each backend, for dedupe/linking.';

-- =====================================================================
-- service_catalog  (routing + decision-tree CONFIG, editable without code)
-- =====================================================================
create table service_catalog (
  service_type        service_type primary key,
  label               text not null,
  brand               text,                  -- Advosy brand that owns the line
  provider            provider_type not null,

  -- ServiceTitan routing (hvac / plumbing)
  st_business_unit_id text,
  st_job_type_id      text,

  -- GHL routing (roofing / restoration)
  ghl_location_id     text,
  ghl_calendar_id     text,

  -- FieldRoutes routing (pest_control)
  fr_office_id        text,
  fr_service_type_id  text,

  -- Decision tree: which appointment types this line offers and what each
  -- resolves to in the backend.
  -- e.g. [{"key":"inspection","label":"Inspection","backend_ref":"..."}]
  appointment_types   jsonb not null default '[]'::jsonb,

  default_duration_min integer not null default 60,

  -- Drive-time guard: minutes of slack required on top of travel time.
  drive_buffer_min    integer not null default 15,

  -- Array of service_type values to offer as one-click upsells.
  suggested_addons    jsonb not null default '[]'::jsonb,

  is_active           boolean not null default true
);
comment on table service_catalog is 'Per-service config: backend routing, the appointment-type decision tree, and upsell suggestions. The non-developer-editable control table.';

-- =====================================================================
-- booking_sessions  (one per checkout; holds the lead/attribution data)
-- =====================================================================
create table booking_sessions (
  id             uuid primary key default gen_random_uuid(),
  customer_id    uuid not null references customers (id),
  rep_id         uuid references app_users (id),
  source         source_type not null,
  channel        channel_type not null,
  channel_other  text,                       -- required iff channel = 'other'
  campaign       campaign_type not null,
  campaign_other text,                        -- required iff campaign = 'other'
  notes          text,
  created_at     timestamptz not null default now(),

  constraint channel_other_when_other
    check (channel <> 'other' or (channel_other is not null and length(trim(channel_other)) > 0)),
  constraint campaign_other_when_other
    check (campaign <> 'other' or (campaign_other is not null and length(trim(campaign_other)) > 0))
);
comment on table booking_sessions is 'One row per checkout. Channel + campaign captured once here; the source of truth for attribution.';

-- =====================================================================
-- booking_items  (one per booked service within a session)
-- =====================================================================
create table booking_items (
  id               uuid primary key default gen_random_uuid(),
  session_id       uuid not null references booking_sessions (id) on delete cascade,
  service_type     service_type not null,
  appointment_type appointment_type not null,     -- decision-tree result
  provider         provider_type not null,        -- backend that holds it
  provider_ref     text,                           -- external ID (ST job/appt, GHL appt, FR appt)
  assigned_rep     text,                           -- tech/user assigned downstream
  slot_start       timestamptz,
  slot_end         timestamptz,
  is_upsell        boolean not null default false,
  drive_minutes    integer,                        -- travel time from the rep's prior job (drive-time guard)
  status           booking_status not null default 'booked',
  error_detail     text,                           -- populated when status = 'failed'
  created_at       timestamptz not null default now()
);
comment on table booking_items is 'One booked service. provider_ref links back to the appointment in ServiceTitan / GHL / FieldRoutes.';

create index booking_items_session_idx on booking_items (session_id);
create index booking_sessions_customer_idx on booking_sessions (customer_id);

-- =====================================================================
-- provider_credentials  (POINTERS only — actual secrets live in Vault)
-- =====================================================================
create table provider_credentials (
  id              uuid primary key default gen_random_uuid(),
  provider        provider_type not null,
  label           text not null,            -- e.g. 'GHL - Roofing sub-account'
  -- Non-secret config (tenant/office/location IDs). Secret keys/tokens are
  -- stored in Supabase Vault and referenced by vault_secret_name.
  config          jsonb not null default '{}'::jsonb,
  vault_secret_name text,                    -- name of the Vault secret holding the token/key
  is_active       boolean not null default true,
  created_at      timestamptz not null default now()
);
comment on table provider_credentials is 'Non-secret provider config + a pointer to the Vault secret. NEVER store raw API keys/tokens in this table.';

-- =====================================================================
-- audit_log  (every external API call + result, for debugging)
-- =====================================================================
create table audit_log (
  id          bigint generated always as identity primary key,
  session_id  uuid references booking_sessions (id) on delete set null,
  provider    provider_type,
  action      text not null,                -- e.g. 'get_availability', 'create_booking'
  request     jsonb,
  response    jsonb,
  ok          boolean,
  created_at  timestamptz not null default now()
);
create index audit_log_session_idx on audit_log (session_id);

-- =====================================================================
-- geocode_cache  (address -> coordinates, so we never geocode twice)
-- Used by the drive-time guard. Written by Edge Functions (service role).
-- =====================================================================
create table geocode_cache (
  address_key text primary key,             -- normalized address string
  lat         double precision not null,
  lng         double precision not null,
  provider    text,                          -- 'google' | 'mapbox'
  created_at  timestamptz not null default now()
);
comment on table geocode_cache is 'Address->lat/lng cache for drive-time travel-matrix lookups.';

-- =====================================================================
-- ROW LEVEL SECURITY
-- Authenticated reps can read config and read/write their booking data.
-- Lock down provider_credentials + audit_log to service role only.
-- =====================================================================
alter table customers            enable row level security;
alter table booking_sessions     enable row level security;
alter table booking_items        enable row level security;
alter table service_catalog      enable row level security;
alter table app_users            enable row level security;
alter table provider_credentials enable row level security;
alter table audit_log            enable row level security;
alter table geocode_cache        enable row level security;

-- Authenticated reps: full access to operational data
create policy "auth read catalog"   on service_catalog  for select to authenticated using (true);
create policy "auth rw customers"    on customers        for all   to authenticated using (true) with check (true);
create policy "auth rw sessions"     on booking_sessions for all   to authenticated using (true) with check (true);
create policy "auth rw items"        on booking_items    for all   to authenticated using (true) with check (true);
create policy "auth read users"      on app_users        for select to authenticated using (true);
-- provider_credentials & audit_log: no policies for `authenticated` ->
-- only the service role (used by Edge Functions) can touch them.

-- =====================================================================
-- SEED — service_catalog
-- Backend IDs are placeholders ('TODO_*') to fill in during Phase 0.
-- appointment_types reflect a sensible default per line; adjust freely.
-- =====================================================================
insert into service_catalog
  (service_type, label, brand, provider,
   st_business_unit_id, st_job_type_id, ghl_location_id, ghl_calendar_id,
   fr_office_id, fr_service_type_id, appointment_types, default_duration_min, suggested_addons)
values
  ('hvac', 'Heating & Air', 'Everest', 'servicetitan',
   'TODO_ST_BU_HVAC', 'TODO_ST_JOBTYPE_HVAC', null, null, null, null,
   '[{"key":"inspection","label":"Inspection"},
     {"key":"maintenance","label":"Maintenance"},
     {"key":"repair_replace","label":"Repair / Replace"},
     {"key":"onsite_estimate","label":"On-site Estimate"}]'::jsonb,
   60, '["plumbing","pest_control"]'::jsonb),

  ('plumbing', 'Plumbing', 'Everest', 'servicetitan',
   'TODO_ST_BU_PLUMBING', 'TODO_ST_JOBTYPE_PLUMBING', null, null, null, null,
   '[{"key":"inspection","label":"Inspection"},
     {"key":"maintenance","label":"Maintenance"},
     {"key":"repair_replace","label":"Repair / Replace"},
     {"key":"onsite_estimate","label":"On-site Estimate"}]'::jsonb,
   60, '["hvac"]'::jsonb),

  ('roofing', 'Roofing', 'VRZA', 'ghl',
   null, null, 'TODO_GHL_LOCATION_ROOFING', 'TODO_GHL_CALENDAR_ROOFING', null, null,
   '[{"key":"inspection","label":"Inspection"},
     {"key":"maintenance","label":"Maintenance"},
     {"key":"repair_replace","label":"Repair / Replace"},
     {"key":"onsite_estimate","label":"On-site Estimate"}]'::jsonb,
   90, '["restoration","pest_control"]'::jsonb),

  ('restoration', 'Restoration', 'Bloque Restoration', 'ghl',
   null, null, 'TODO_GHL_LOCATION_RESTORATION', 'TODO_GHL_CALENDAR_RESTORATION', null, null,
   '[{"key":"inspection","label":"Inspection"},
     {"key":"repair_replace","label":"Repair / Replace"},
     {"key":"onsite_estimate","label":"On-site Estimate"}]'::jsonb,
   90, '["roofing"]'::jsonb),

  ('pest_control', 'Pest Control', 'Pestkee', 'fieldroutes',
   null, null, null, null, 'TODO_FR_OFFICE', 'TODO_FR_SERVICETYPE',
   '[{"key":"inspection","label":"Inspection"},
     {"key":"maintenance","label":"Maintenance"},
     {"key":"onsite_estimate","label":"On-site Estimate"}]'::jsonb,
   45, '["hvac"]'::jsonb);

-- =====================================================================
-- Reference: option labels for the front-end dropdowns
-- (Stored here as a comment; the app can also hardcode or read enum values.)
--
-- Channel:  Meta Ads | LSA (Local Services Ads) | Thumbtack |
--           Outbound Calling | Organic Social | Jobsite Marketing |
--           EDDM (Direct Mail) | B2B Affiliate | Other (free text)
--
-- Campaign: Demand Generation | High Intent | We Are Advosy |
--           Sales Enablement | Brand Awareness | Other (free text)
--
-- Appointment Type: Inspection | Maintenance | Repair / Replace | On-site Estimate
-- =====================================================================
