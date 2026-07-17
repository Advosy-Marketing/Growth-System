-- ============================================================================
-- Advosy Growth - Supabase schema export
-- Source project: andzztvmaleiefxcfjwh (https://andzztvmaleiefxcfjwh.supabase.co)
-- Exported: 2026-07-17 via catalog queries (pg_dump not available)
-- Contents: extensions, enum types, 39 tables, FKs, indexes, 1 view,
--           4 functions, 2 triggers, RLS + 6 policies, custom grants.
-- Apply order is safe for an EMPTY new Supabase project.
-- Cron jobs are in cron_jobs.sql; storage buckets in storage_buckets.sql.
-- NOTE: public.get_secret() reads vault.decrypted_secrets - recreate the
--       needed Vault secrets (e.g. AI_WEBHOOK_TOKEN) in the new project.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. EXTENSIONS
-- ----------------------------------------------------------------------------
-- Already present by default on Supabase: plpgsql, pg_stat_statements, supabase_vault
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto   WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_cron;               -- enable via Dashboard > Integrations if this errors
CREATE EXTENSION IF NOT EXISTS pg_net;                -- source had it installed in schema public; functions live in schema net

-- ----------------------------------------------------------------------------
-- 2. ENUM TYPES
-- ----------------------------------------------------------------------------
CREATE TYPE public.appointment_type AS ENUM ('inspection', 'maintenance', 'repair_replace', 'onsite_estimate', 'sold_customer');
CREATE TYPE public.booking_status   AS ENUM ('booked', 'failed', 'cancelled');
CREATE TYPE public.campaign_type    AS ENUM ('demand_generation', 'high_intent', 'we_are_advosy', 'sales_enablement', 'brand_awareness', 'other');
CREATE TYPE public.channel_type     AS ENUM ('meta_ads', 'lsa', 'thumbtack', 'outbound_calling', 'organic_social', 'jobsite_marketing', 'eddm', 'b2b_affiliate', 'other');
CREATE TYPE public.provider_type    AS ENUM ('servicetitan', 'ghl', 'fieldroutes');
CREATE TYPE public.service_type     AS ENUM ('hvac', 'plumbing', 'roofing', 'restoration', 'pest_control');
CREATE TYPE public.source_type      AS ENUM ('inbound', 'outbound', 'both', 'AI Setter');

-- ----------------------------------------------------------------------------
-- 3. TABLES (no foreign keys yet; FKs added in section 4)
-- ----------------------------------------------------------------------------

CREATE TABLE public.ad_creatives (
  id text NOT NULL,
  funnel_id text,
  offer_id text,
  format text DEFAULT 'image'::text,
  hook text,
  primary_text text,
  headline text,
  description text,
  asset_ref text,
  status text DEFAULT 'concept'::text,
  meta_ad_id text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  visual_direction text,
  image_status text DEFAULT 'none'::text,
  image_job text,
  usage text,
  meta_status text DEFAULT 'none'::text,
  CONSTRAINT ad_creatives_pkey PRIMARY KEY (id)
);

CREATE TABLE public.ai_brand_profiles (
  brand text NOT NULL,
  display_name text NOT NULL,
  service_types text[] DEFAULT '{}'::text[] NOT NULL,
  persona_name text DEFAULT 'Alex'::text NOT NULL,
  tone text DEFAULT 'friendly, brief, human. Texts like a real appointment coordinator, not a bot.'::text NOT NULL,
  faq text DEFAULT ''::text NOT NULL,
  booking_enabled boolean DEFAULT true NOT NULL,
  active boolean DEFAULT true NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT ai_brand_profiles_pkey PRIMARY KEY (brand)
);

CREATE TABLE public.ai_campaign_offers (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  brand text NOT NULL,
  match_source text,
  match_campaign text,
  offer_name text NOT NULL,
  offer_text text NOT NULL,
  initial_charge_override numeric,
  active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT ai_campaign_offers_pkey PRIMARY KEY (id)
);

CREATE TABLE public.ai_conversations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  ghl_contact_id text NOT NULL,
  ghl_conversation_id text,
  brand text DEFAULT 'advosy'::text NOT NULL,
  lead_source text,
  intent text,
  status text DEFAULT 'active'::text NOT NULL,
  channel text DEFAULT 'sms'::text NOT NULL,
  contact_name text,
  contact_phone text,
  contact_email text,
  context jsonb DEFAULT '{}'::jsonb NOT NULL,
  last_inbound_at timestamp with time zone,
  last_outbound_at timestamp with time zone,
  msgs_sent_on date,
  msgs_sent_count integer DEFAULT 0 NOT NULL,
  flagged_reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  owner text DEFAULT 'team'::text NOT NULL,
  fr_customer_id text,
  campaign text,
  CONSTRAINT ai_conversations_pkey PRIMARY KEY (id),
  CONSTRAINT ai_conversations_ghl_contact_id_key UNIQUE (ghl_contact_id)
);

CREATE TABLE public.ai_messages (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  conversation_id uuid NOT NULL,
  ghl_message_id text,
  direction text NOT NULL,
  channel text DEFAULT 'sms'::text NOT NULL,
  body text NOT NULL,
  ai_generated boolean DEFAULT false NOT NULL,
  meta jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT ai_messages_pkey PRIMARY KEY (id)
);

CREATE TABLE public.ai_pending_replies (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  conversation_id uuid NOT NULL,
  inbound_at timestamp with time zone DEFAULT now() NOT NULL,
  due_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT ai_pending_replies_pkey PRIMARY KEY (id)
);

CREATE TABLE public.ai_settings (
  id integer DEFAULT 1 NOT NULL,
  mode text DEFAULT 'supervised'::text NOT NULL,
  quiet_start integer DEFAULT 20 NOT NULL,
  quiet_end integer DEFAULT 8 NOT NULL,
  timezone text DEFAULT 'America/Phoenix'::text NOT NULL,
  max_msgs_per_day integer DEFAULT 6 NOT NULL,
  model text DEFAULT 'claude-sonnet-5'::text NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  sla_minutes integer DEFAULT 5 NOT NULL,
  reengage_minutes integer DEFAULT 120 NOT NULL,
  takeover_until timestamp with time zone,
  CONSTRAINT ai_settings_pkey PRIMARY KEY (id),
  CONSTRAINT ai_settings_id_check CHECK ((id = 1))
);

CREATE TABLE public.app_users (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  full_name text NOT NULL,
  team public.source_type,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  role text DEFAULT 'rep'::text NOT NULL,
  pin text,
  hourly_rate numeric(10,2),
  color text,
  CONSTRAINT app_users_pkey PRIMARY KEY (id)
);

CREATE TABLE public.audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  session_id uuid,
  provider public.provider_type,
  action text NOT NULL,
  request jsonb,
  response jsonb,
  ok boolean,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT audit_log_pkey PRIMARY KEY (id)
);

CREATE TABLE public.booking_items (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  session_id uuid NOT NULL,
  service_type public.service_type NOT NULL,
  appointment_type public.appointment_type NOT NULL,
  provider public.provider_type NOT NULL,
  provider_ref text,
  assigned_rep text,
  slot_start timestamp with time zone,
  slot_end timestamp with time zone,
  is_upsell boolean DEFAULT false NOT NULL,
  drive_minutes integer,
  status public.booking_status DEFAULT 'booked'::public.booking_status NOT NULL,
  error_detail text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  contract_value numeric(12,2),
  sale_type text,
  sale_type_other text,
  cancel_reason text,
  updated_at timestamp with time zone,
  CONSTRAINT booking_items_pkey PRIMARY KEY (id)
);

CREATE TABLE public.booking_sessions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  customer_id uuid NOT NULL,
  rep_id uuid,
  source public.source_type NOT NULL,
  channel public.channel_type NOT NULL,
  channel_other text,
  campaign public.campaign_type NOT NULL,
  campaign_other text,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  emergency boolean DEFAULT false,
  gate_code text,
  updated_at timestamp with time zone,
  CONSTRAINT booking_sessions_pkey PRIMARY KEY (id),
  CONSTRAINT campaign_other_when_other CHECK (((campaign <> 'other'::public.campaign_type) OR ((campaign_other IS NOT NULL) AND (length(TRIM(BOTH FROM campaign_other)) > 0)))),
  CONSTRAINT channel_other_when_other CHECK (((channel <> 'other'::public.channel_type) OR ((channel_other IS NOT NULL) AND (length(TRIM(BOTH FROM channel_other)) > 0))))
);

CREATE TABLE public.brand_assets (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  brand_id text,
  kind text DEFAULT 'other'::text,
  label text,
  storage_path text,
  url text,
  higgsfield_media_id text,
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT brand_assets_pkey PRIMARY KEY (id)
);

CREATE TABLE public.brands (
  id text NOT NULL,
  name text NOT NULL,
  vertical text,
  market text,
  live_site text,
  standing_proof_points text[] DEFAULT '{}'::text[],
  status text DEFAULT 'active'::text,
  design_system_id text,
  note text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  fb_page_id text,
  fb_pixel_id text,
  fb_ad_account_id text,
  creative_brief text,
  CONSTRAINT brands_pkey PRIMARY KEY (id)
);

CREATE TABLE public.campaign_comments (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  campaign_id text,
  author text,
  body text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT campaign_comments_pkey PRIMARY KEY (id)
);

CREATE TABLE public.campaign_tasks (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  campaign_id text,
  title text NOT NULL,
  assignee text,
  status text DEFAULT 'open'::text,
  created_by text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT campaign_tasks_pkey PRIMARY KEY (id)
);

CREATE TABLE public.campaigns (
  id text NOT NULL,
  brand_id text,
  name text NOT NULL,
  objective text,
  status text DEFAULT 'idea'::text,
  start_date date,
  end_date date,
  owner text,
  extra jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  goal text,
  sales_enablement jsonb DEFAULT '[]'::jsonb,
  builder jsonb DEFAULT '{}'::jsonb,
  attribution jsonb DEFAULT '{}'::jsonb,
  CONSTRAINT campaigns_pkey PRIMARY KEY (id)
);

CREATE TABLE public.commission_matrix (
  service_type public.service_type NOT NULL,
  appointment_type public.appointment_type NOT NULL,
  amount numeric(10,2) DEFAULT 0 NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT commission_matrix_pkey PRIMARY KEY (service_type, appointment_type)
);

CREATE TABLE public.commission_rates (
  appointment_type public.appointment_type NOT NULL,
  label text NOT NULL,
  amount numeric(10,2) DEFAULT 0 NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT commission_rates_pkey PRIMARY KEY (appointment_type)
);

CREATE TABLE public.commissions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  booking_item_id uuid,
  user_id uuid,
  time_entry_id uuid,
  appointment_type public.appointment_type NOT NULL,
  service_type public.service_type,
  amount numeric(10,2) DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT commissions_pkey PRIMARY KEY (id),
  CONSTRAINT commissions_booking_item_id_key UNIQUE (booking_item_id)
);

CREATE TABLE public.customers (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  phone text,
  email text,
  address text,
  lat double precision,
  lng double precision,
  external_refs jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT customers_pkey PRIMARY KEY (id)
);

CREATE TABLE public.design_systems (
  id text NOT NULL,
  brand_id text,
  design_dna text,
  color_tokens jsonb DEFAULT '{}'::jsonb,
  typography jsonb DEFAULT '{}'::jsonb,
  spacing_rhythm text,
  component_library_ref text,
  reference_doc_ref text,
  brand_assets jsonb DEFAULT '[]'::jsonb,
  source text,
  extra jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  component_html text,
  CONSTRAINT design_systems_pkey PRIMARY KEY (id)
);

CREATE TABLE public.fr_customer_sync (
  fr_customer_id text NOT NULL,
  sub_status text NOT NULL,
  ghl_contact_id text,
  customer_name text,
  synced_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT fr_customer_sync_pkey PRIMARY KEY (fr_customer_id)
);

CREATE TABLE public.funnels (
  id text NOT NULL,
  offer_id text,
  name text NOT NULL,
  steps text[] DEFAULT '{}'::text[],
  entry_type text,
  crm text DEFAULT 'GoHighLevel'::text,
  status text DEFAULT 'designed'::text,
  extra jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT funnels_pkey PRIMARY KEY (id)
);

CREATE TABLE public.geocode_cache (
  address_key text NOT NULL,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  provider text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT geocode_cache_pkey PRIMARY KEY (address_key)
);

CREATE TABLE public.ghl_calls (
  id text NOT NULL,
  contact_id text,
  conversation_id text,
  direction text,
  call_status text,
  duration integer,
  from_num text,
  to_num text,
  call_date timestamp with time zone,
  synced_at timestamp with time zone DEFAULT now(),
  user_id text,
  CONSTRAINT ghl_calls_pkey PRIMARY KEY (id)
);

CREATE TABLE public.ghl_sync_state (
  k text NOT NULL,
  ts timestamp with time zone,
  note text,
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT ghl_sync_state_pkey PRIMARY KEY (k)
);

CREATE TABLE public.ghl_users (
  id text NOT NULL,
  name text,
  email text,
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT ghl_users_pkey PRIMARY KEY (id)
);

CREATE TABLE public.hours_overrides (
  user_id uuid NOT NULL,
  period_start timestamp with time zone NOT NULL,
  period_end timestamp with time zone NOT NULL,
  hours numeric(8,2) NOT NULL,
  updated_by uuid,
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT hours_overrides_pkey PRIMARY KEY (user_id, period_start, period_end)
);

CREATE TABLE public.landing_pages (
  id text NOT NULL,
  funnel_id text,
  brand_id text,
  title text,
  type text DEFAULT 'offer_page'::text,
  file_ref text,
  storage_path text,
  html_content text,
  deploy_url text,
  deploy_platform text,
  lead_integration jsonb DEFAULT '{}'::jsonb,
  variant_of text,
  status text DEFAULT 'draft'::text,
  extra jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT landing_pages_pkey PRIMARY KEY (id)
);

CREATE TABLE public.marketing_cache (
  range_key text NOT NULL,
  payload jsonb NOT NULL,
  fetched_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT marketing_cache_pkey PRIMARY KEY (range_key)
);

CREATE TABLE public.meta_campaigns (
  id text NOT NULL,
  meta_campaign_id text,
  funnel_id text,
  name text,
  objective text,
  status text DEFAULT 'draft'::text,
  budget jsonb DEFAULT '{}'::jsonb,
  adsets jsonb DEFAULT '[]'::jsonb,
  metrics jsonb DEFAULT '{}'::jsonb,
  last_synced timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT meta_campaigns_pkey PRIMARY KEY (id)
);

CREATE TABLE public.nurture_enrollments (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  conversation_id uuid NOT NULL,
  sequence text NOT NULL,
  step integer DEFAULT 0 NOT NULL,
  next_action_at timestamp with time zone DEFAULT now() NOT NULL,
  status text DEFAULT 'active'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT nurture_enrollments_pkey PRIMARY KEY (id)
);

CREATE TABLE public.nurture_sequences (
  sequence text NOT NULL,
  steps jsonb NOT NULL,
  active boolean DEFAULT true NOT NULL,
  CONSTRAINT nurture_sequences_pkey PRIMARY KEY (sequence)
);

CREATE TABLE public.offers (
  id text NOT NULL,
  campaign_id text,
  name text NOT NULL,
  avatar text,
  angle_family text,
  value_stack jsonb DEFAULT '[]'::jsonb,
  pricing text,
  why text,
  cta_direct text,
  cta_transitional text,
  brandscript jsonb DEFAULT '{}'::jsonb,
  channels text[] DEFAULT '{}'::text[],
  status text DEFAULT 'tbd'::text,
  extra jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT offers_pkey PRIMARY KEY (id)
);

CREATE TABLE public.pin_attempts (
  user_id uuid NOT NULL,
  fail_count integer DEFAULT 0 NOT NULL,
  locked_until timestamp with time zone,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT pin_attempts_pkey PRIMARY KEY (user_id)
);

CREATE TABLE public.provider_credentials (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  provider public.provider_type NOT NULL,
  label text NOT NULL,
  config jsonb DEFAULT '{}'::jsonb NOT NULL,
  vault_secret_name text,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT provider_credentials_pkey PRIMARY KEY (id)
);

CREATE TABLE public.service_catalog (
  service_type public.service_type NOT NULL,
  label text NOT NULL,
  brand text,
  provider public.provider_type NOT NULL,
  st_business_unit_id text,
  st_job_type_id text,
  ghl_location_id text,
  ghl_calendar_id text,
  fr_office_id text,
  fr_service_type_id text,
  appointment_types jsonb DEFAULT '[]'::jsonb NOT NULL,
  default_duration_min integer DEFAULT 60 NOT NULL,
  drive_buffer_min integer DEFAULT 15 NOT NULL,
  suggested_addons jsonb DEFAULT '[]'::jsonb NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  CONSTRAINT service_catalog_pkey PRIMARY KEY (service_type)
);

CREATE TABLE public.thumbtack_leads (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  lead_id text,
  company text,
  service_category text,
  customer_name text,
  phone text,
  price numeric(10,2),
  lead_type text,
  lead_created timestamp with time zone,
  raw jsonb,
  received_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT thumbtack_leads_pkey PRIMARY KEY (id),
  CONSTRAINT thumbtack_leads_lead_id_key UNIQUE (lead_id)
);

CREATE TABLE public.time_entries (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  clock_in timestamp with time zone DEFAULT now() NOT NULL,
  clock_out timestamp with time zone,
  source text DEFAULT 'web'::text NOT NULL,
  note text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT time_entries_pkey PRIMARY KEY (id)
);

-- ----------------------------------------------------------------------------
-- 4. FOREIGN KEYS (added after all tables to avoid ordering issues)
-- ----------------------------------------------------------------------------
ALTER TABLE public.ad_creatives        ADD CONSTRAINT ad_creatives_funnel_id_fkey           FOREIGN KEY (funnel_id) REFERENCES public.funnels(id) ON DELETE CASCADE;
ALTER TABLE public.ad_creatives        ADD CONSTRAINT ad_creatives_offer_id_fkey            FOREIGN KEY (offer_id) REFERENCES public.offers(id) ON DELETE SET NULL;
ALTER TABLE public.ai_campaign_offers  ADD CONSTRAINT ai_campaign_offers_brand_fkey         FOREIGN KEY (brand) REFERENCES public.ai_brand_profiles(brand);
ALTER TABLE public.ai_conversations    ADD CONSTRAINT ai_conversations_brand_fkey           FOREIGN KEY (brand) REFERENCES public.ai_brand_profiles(brand);
ALTER TABLE public.ai_messages         ADD CONSTRAINT ai_messages_conversation_id_fkey      FOREIGN KEY (conversation_id) REFERENCES public.ai_conversations(id) ON DELETE CASCADE;
ALTER TABLE public.ai_pending_replies  ADD CONSTRAINT ai_pending_replies_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.ai_conversations(id) ON DELETE CASCADE;
ALTER TABLE public.audit_log           ADD CONSTRAINT audit_log_session_id_fkey             FOREIGN KEY (session_id) REFERENCES public.booking_sessions(id) ON DELETE SET NULL;
ALTER TABLE public.booking_items       ADD CONSTRAINT booking_items_session_id_fkey         FOREIGN KEY (session_id) REFERENCES public.booking_sessions(id) ON DELETE CASCADE;
ALTER TABLE public.booking_sessions    ADD CONSTRAINT booking_sessions_customer_id_fkey     FOREIGN KEY (customer_id) REFERENCES public.customers(id);
ALTER TABLE public.booking_sessions    ADD CONSTRAINT booking_sessions_rep_id_fkey          FOREIGN KEY (rep_id) REFERENCES public.app_users(id);
ALTER TABLE public.brand_assets        ADD CONSTRAINT brand_assets_brand_id_fkey            FOREIGN KEY (brand_id) REFERENCES public.brands(id) ON DELETE CASCADE;
ALTER TABLE public.campaign_comments   ADD CONSTRAINT campaign_comments_campaign_id_fkey    FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;
ALTER TABLE public.campaign_tasks      ADD CONSTRAINT campaign_tasks_campaign_id_fkey       FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;
ALTER TABLE public.campaigns           ADD CONSTRAINT campaigns_brand_id_fkey               FOREIGN KEY (brand_id) REFERENCES public.brands(id) ON DELETE CASCADE;
ALTER TABLE public.commissions         ADD CONSTRAINT commissions_booking_item_id_fkey      FOREIGN KEY (booking_item_id) REFERENCES public.booking_items(id) ON DELETE CASCADE;
ALTER TABLE public.commissions         ADD CONSTRAINT commissions_time_entry_id_fkey        FOREIGN KEY (time_entry_id) REFERENCES public.time_entries(id) ON DELETE SET NULL;
ALTER TABLE public.commissions         ADD CONSTRAINT commissions_user_id_fkey              FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE SET NULL;
ALTER TABLE public.customers           ADD CONSTRAINT customers_created_by_fkey             FOREIGN KEY (created_by) REFERENCES public.app_users(id);
ALTER TABLE public.design_systems      ADD CONSTRAINT design_systems_brand_id_fkey          FOREIGN KEY (brand_id) REFERENCES public.brands(id) ON DELETE CASCADE;
ALTER TABLE public.funnels             ADD CONSTRAINT funnels_offer_id_fkey                 FOREIGN KEY (offer_id) REFERENCES public.offers(id) ON DELETE CASCADE;
ALTER TABLE public.hours_overrides     ADD CONSTRAINT hours_overrides_user_id_fkey          FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;
ALTER TABLE public.landing_pages       ADD CONSTRAINT landing_pages_brand_id_fkey           FOREIGN KEY (brand_id) REFERENCES public.brands(id) ON DELETE SET NULL;
ALTER TABLE public.landing_pages       ADD CONSTRAINT landing_pages_funnel_id_fkey          FOREIGN KEY (funnel_id) REFERENCES public.funnels(id) ON DELETE SET NULL;
ALTER TABLE public.landing_pages       ADD CONSTRAINT landing_pages_variant_of_fkey         FOREIGN KEY (variant_of) REFERENCES public.landing_pages(id) ON DELETE SET NULL;
ALTER TABLE public.meta_campaigns      ADD CONSTRAINT meta_campaigns_funnel_id_fkey         FOREIGN KEY (funnel_id) REFERENCES public.funnels(id) ON DELETE SET NULL;
ALTER TABLE public.nurture_enrollments ADD CONSTRAINT nurture_enrollments_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.ai_conversations(id) ON DELETE CASCADE;
ALTER TABLE public.nurture_enrollments ADD CONSTRAINT nurture_enrollments_sequence_fkey     FOREIGN KEY (sequence) REFERENCES public.nurture_sequences(sequence);
ALTER TABLE public.offers              ADD CONSTRAINT offers_campaign_id_fkey               FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE SET NULL;
ALTER TABLE public.pin_attempts        ADD CONSTRAINT pin_attempts_user_id_fkey             FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;
ALTER TABLE public.time_entries        ADD CONSTRAINT time_entries_user_id_fkey             FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;

-- ----------------------------------------------------------------------------
-- 5. INDEXES (non-constraint)
-- ----------------------------------------------------------------------------
CREATE INDEX ac_funnel_idx ON public.ad_creatives USING btree (funnel_id);
CREATE INDEX ac_imgq ON public.ad_creatives USING btree (image_status) WHERE (image_status = 'queued'::text);
CREATE INDEX ac_metaq ON public.ad_creatives USING btree (meta_status) WHERE (meta_status = 'queued'::text);
CREATE INDEX audit_log_session_idx ON public.audit_log USING btree (session_id);
CREATE INDEX booking_items_session_idx ON public.booking_items USING btree (session_id);
CREATE INDEX booking_sessions_customer_idx ON public.booking_sessions USING btree (customer_id);
CREATE INDEX brand_assets_brand_idx ON public.brand_assets USING btree (brand_id);
CREATE INDEX ccomments_camp ON public.campaign_comments USING btree (campaign_id);
CREATE INDEX commissions_created_idx ON public.commissions USING btree (created_at);
CREATE INDEX commissions_entry_idx ON public.commissions USING btree (time_entry_id);
CREATE INDEX commissions_user_idx ON public.commissions USING btree (user_id);
CREATE INDEX ctasks_camp ON public.campaign_tasks USING btree (campaign_id);
CREATE INDEX ds_brand_idx ON public.design_systems USING btree (brand_id);
CREATE INDEX funnels_offer_idx ON public.funnels USING btree (offer_id);
CREATE INDEX ghl_calls_date_idx ON public.ghl_calls USING btree (call_date);
CREATE INDEX ghl_calls_dir_idx ON public.ghl_calls USING btree (direction);
CREATE INDEX ghl_calls_user_id_idx ON public.ghl_calls USING btree (user_id);
CREATE INDEX idx_ai_conv_status ON public.ai_conversations USING btree (status);
CREATE INDEX idx_ai_msgs_conv ON public.ai_messages USING btree (conversation_id, created_at);
CREATE INDEX idx_nurture_due ON public.nurture_enrollments USING btree (status, next_action_at);
CREATE INDEX idx_pending_due ON public.ai_pending_replies USING btree (due_at);
CREATE INDEX lp_funnel_idx ON public.landing_pages USING btree (funnel_id);
CREATE INDEX mc_funnel_idx ON public.meta_campaigns USING btree (funnel_id);
CREATE INDEX offers_campaign_idx ON public.offers USING btree (campaign_id);
CREATE UNIQUE INDEX one_open_entry_per_user ON public.time_entries USING btree (user_id) WHERE (clock_out IS NULL);
CREATE INDEX thumbtack_leads_company_idx ON public.thumbtack_leads USING btree (company);
CREATE INDEX thumbtack_leads_received_idx ON public.thumbtack_leads USING btree (received_at);
CREATE INDEX time_entries_clockin_idx ON public.time_entries USING btree (clock_in);
CREATE INDEX time_entries_user_idx ON public.time_entries USING btree (user_id);

-- ----------------------------------------------------------------------------
-- 6. VIEWS
-- ----------------------------------------------------------------------------
-- Roster view: exposes app_users WITHOUT the pin column (SELECT on app_users is
-- revoked from anon/authenticated; clients read the roster through this view).
CREATE OR REPLACE VIEW public.v_roster AS
 SELECT id,
    full_name,
    team,
    role,
    hourly_rate,
    color,
    is_active,
    created_at
   FROM public.app_users;

-- ----------------------------------------------------------------------------
-- 7. FUNCTIONS
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_commission_on_booking()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_rep uuid; v_amount numeric(10,2); v_entry uuid;
begin
  if new.status <> 'booked' then return new; end if;
  select rep_id into v_rep from booking_sessions where id = new.session_id;
  if v_rep is null then return new; end if;
  select amount into v_amount from commission_matrix
    where service_type = new.service_type and appointment_type = new.appointment_type;
  if v_amount is null then
    select amount into v_amount from commission_rates
      where appointment_type = new.appointment_type and is_active;
  end if;
  v_amount := coalesce(v_amount,0);
  select id into v_entry from time_entries
    where user_id = v_rep and clock_out is null order by clock_in desc limit 1;
  insert into commissions (booking_item_id, user_id, time_entry_id, appointment_type, service_type, amount)
  values (new.id, v_rep, v_entry, new.appointment_type, new.service_type, v_amount)
  on conflict (booking_item_id) do nothing;
  return new;
end $function$
;

-- Reads Supabase Vault secrets (recreate secrets in the new project's Vault)
CREATE OR REPLACE FUNCTION public.get_secret(p_name text)
 RETURNS text
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select decrypted_secret from vault.decrypted_secrets where name = p_name limit 1;
$function$
;

CREATE OR REPLACE FUNCTION public.hash_pin(p_pin text)
 RETURNS text
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'extensions'
AS $function$ select crypt(p_pin, gen_salt('bf')) $function$
;

CREATE OR REPLACE FUNCTION public.verify_pin(p_user uuid, p_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  u record;
  att record;
  v_ok boolean := false;
  v_fails int;
begin
  select id, full_name, role, team, is_active, pin into u from app_users where id = p_user;
  if u.id is null or not u.is_active then
    return jsonb_build_object('ok', false, 'error', 'user not found');
  end if;

  select * into att from pin_attempts where user_id = p_user;
  if att.locked_until is not null and att.locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'too many failed attempts — try again in a few minutes');
  end if;

  if u.pin like '$2%' then
    v_ok := (u.pin = extensions.crypt(p_pin, u.pin));
  else
    v_ok := (u.pin is not null and u.pin = p_pin);
  end if;

  if v_ok then
    delete from pin_attempts where user_id = p_user;
    return jsonb_build_object('ok', true, 'user_id', u.id, 'full_name', u.full_name, 'role', u.role, 'team', u.team);
  end if;

  v_fails := case when att.updated_at is null or att.updated_at < now() - interval '15 minutes'
                  then 1 else att.fail_count + 1 end;
  insert into pin_attempts (user_id, fail_count, locked_until, updated_at)
  values (p_user, v_fails, case when v_fails >= 8 then now() + interval '15 minutes' end, now())
  on conflict (user_id) do update
    set fail_count = excluded.fail_count,
        locked_until = excluded.locked_until,
        updated_at = excluded.updated_at;
  return jsonb_build_object('ok', false, 'error', 'invalid pin');
end $function$
;

-- ----------------------------------------------------------------------------
-- 8. TRIGGERS
-- ----------------------------------------------------------------------------
CREATE TRIGGER trg_commission_on_insert
  AFTER INSERT ON public.booking_items
  FOR EACH ROW EXECUTE FUNCTION public.create_commission_on_booking();

CREATE TRIGGER trg_commission_on_update
  AFTER UPDATE OF status ON public.booking_items
  FOR EACH ROW
  WHEN (((new.status = 'booked'::public.booking_status) AND (old.status IS DISTINCT FROM 'booked'::public.booking_status)))
  EXECUTE FUNCTION public.create_commission_on_booking();

-- ----------------------------------------------------------------------------
-- 9. ROW LEVEL SECURITY
-- ----------------------------------------------------------------------------
-- RLS is enabled on ALL public tables. Only 6 tables have policies (read-only);
-- everything else is service-role-only (edge functions use the service key).
ALTER TABLE public.ad_creatives         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_brand_profiles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_campaign_offers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_conversations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_messages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_pending_replies   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_settings          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_users            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_items        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_sessions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brand_assets         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brands               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_comments    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_tasks       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaigns            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commission_matrix    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commission_rates     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commissions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.design_systems       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fr_customer_sync     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.funnels              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.geocode_cache        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ghl_calls            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ghl_sync_state       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ghl_users            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hours_overrides      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_pages        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_cache      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_campaigns       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nurture_enrollments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nurture_sequences    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.offers               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pin_attempts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_catalog      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.thumbtack_leads      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.time_entries         ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "roster read"        ON public.app_users         AS PERMISSIVE FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "read matrix"        ON public.commission_matrix AS PERMISSIVE FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "read rates"         ON public.commission_rates  AS PERMISSIVE FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "read commissions"   ON public.commissions       AS PERMISSIVE FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "auth read catalog"  ON public.service_catalog   AS PERMISSIVE FOR SELECT TO authenticated USING (true);
CREATE POLICY "read entries"       ON public.time_entries      AS PERMISSIVE FOR SELECT TO anon, authenticated USING (true);

-- ----------------------------------------------------------------------------
-- 10. GRANTS
-- ----------------------------------------------------------------------------
-- All tables carry the Supabase default grants (ALL to anon/authenticated/
-- service_role), with ONE deliberate deviation in the source project:
-- SELECT on app_users is revoked from anon and authenticated so the plaintext
-- pin column can never be read by clients (they use v_roster + verify_pin()).
REVOKE SELECT ON public.app_users FROM anon, authenticated;
