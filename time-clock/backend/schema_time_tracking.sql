-- =====================================================================
-- Advosy Growth — Time Tracking + Commissions
-- Extends the unified booking system, SAME Supabase project (advosy-booking).
-- Project ref: andzztvmaleiefxcfjwh
--
-- Already applied to the live project. Included here as the source of truth.
-- Safe to re-run (idempotent guards where possible).
-- =====================================================================

-- ---- Decouple reps from auth.users (PIN-based identity) ----
alter table app_users drop constraint if exists app_users_id_fkey;
alter table app_users alter column id set default gen_random_uuid();
alter table app_users add column if not exists role text not null default 'rep';   -- rep | manager | admin
alter table app_users add column if not exists pin  text;                           -- 4-6 digit, validated server-side
alter table app_users add column if not exists hourly_rate numeric(10,2);           -- optional, for labor cost
alter table app_users add column if not exists color text;                          -- avatar accent

-- =====================================================================
-- commission_rates  (editable $ per appointment / opportunity type)
-- =====================================================================
create table if not exists commission_rates (
  appointment_type appointment_type primary key,
  label            text not null,
  amount           numeric(10,2) not null default 0,
  is_active        boolean not null default true,
  updated_at       timestamptz not null default now()
);

insert into commission_rates (appointment_type, label, amount) values
  ('inspection',     'Inspection',        25),
  ('maintenance',    'Maintenance',       20),
  ('repair_replace', 'Repair / Replace',  50),
  ('onsite_estimate','On-site Estimate',  35)
on conflict (appointment_type) do nothing;

-- =====================================================================
-- time_entries  (clock in / out)
-- =====================================================================
create table if not exists time_entries (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references app_users (id) on delete cascade,
  clock_in   timestamptz not null default now(),
  clock_out  timestamptz,
  source     text not null default 'web',
  note       text,
  created_at timestamptz not null default now()
);
create unique index if not exists one_open_entry_per_user
  on time_entries (user_id) where clock_out is null;
create index if not exists time_entries_user_idx on time_entries (user_id);
create index if not exists time_entries_clockin_idx on time_entries (clock_in);

-- =====================================================================
-- commissions  (one per booked item, tied to the rep's open shift)
-- =====================================================================
create table if not exists commissions (
  id               uuid primary key default gen_random_uuid(),
  booking_item_id  uuid unique references booking_items (id) on delete cascade,
  user_id          uuid references app_users (id) on delete set null,
  time_entry_id    uuid references time_entries (id) on delete set null,
  appointment_type appointment_type not null,
  service_type     service_type,
  amount           numeric(10,2) not null default 0,
  created_at       timestamptz not null default now()
);
create index if not exists commissions_user_idx on commissions (user_id);
create index if not exists commissions_entry_idx on commissions (time_entry_id);
create index if not exists commissions_created_idx on commissions (created_at);

-- =====================================================================
-- Trigger: auto-create a commission when a booking_item is booked,
-- attributed to the session's rep and their currently-open shift.
-- THIS is the live link between the booking system and the time clock.
-- =====================================================================
create or replace function create_commission_on_booking()
returns trigger language plpgsql security definer
set search_path = public as $$
declare
  v_rep    uuid;
  v_amount numeric(10,2);
  v_entry  uuid;
begin
  if new.status <> 'booked' then
    return new;
  end if;

  select rep_id into v_rep from booking_sessions where id = new.session_id;
  if v_rep is null then
    return new;  -- no rep attributed; skip
  end if;

  select amount into v_amount
    from commission_rates
   where appointment_type = new.appointment_type and is_active;
  v_amount := coalesce(v_amount, 0);

  select id into v_entry
    from time_entries
   where user_id = v_rep and clock_out is null
   order by clock_in desc
   limit 1;

  insert into commissions
    (booking_item_id, user_id, time_entry_id, appointment_type, service_type, amount)
  values
    (new.id, v_rep, v_entry, new.appointment_type, new.service_type, v_amount)
  on conflict (booking_item_id) do nothing;

  return new;
end $$;

drop trigger if exists trg_commission_on_insert on booking_items;
create trigger trg_commission_on_insert
  after insert on booking_items
  for each row execute function create_commission_on_booking();

drop trigger if exists trg_commission_on_update on booking_items;
create trigger trg_commission_on_update
  after update of status on booking_items
  for each row when (new.status = 'booked' and old.status is distinct from 'booked')
  execute function create_commission_on_booking();

-- =====================================================================
-- RLS — reads for the app (anon + authenticated). Writes go through
-- Edge Functions running as service_role, which bypass RLS.
-- =====================================================================
alter table commission_rates enable row level security;
alter table time_entries     enable row level security;
alter table commissions      enable row level security;

drop policy if exists "read rates" on commission_rates;
create policy "read rates" on commission_rates for select to anon, authenticated using (true);

drop policy if exists "read entries" on time_entries;
create policy "read entries" on time_entries for select to anon, authenticated using (true);

drop policy if exists "read commissions" on commissions;
create policy "read commissions" on commissions for select to anon, authenticated using (true);

-- PIN-safe roster view (never exposes pin)
create or replace view v_roster as
  select id, full_name, team, role, hourly_rate, color, is_active, created_at
  from app_users;
grant select on v_roster to anon, authenticated;

-- Realtime: push live time + commission changes to clients
do $$
begin
  begin alter publication supabase_realtime add table time_entries; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table commissions;  exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table app_users;    exception when duplicate_object then null; end;
end $$;

-- Seed first admin (change PIN immediately in the Admin tab)
insert into app_users (full_name, team, role, pin, color, is_active)
select 'Chandler Ricks', 'inbound', 'admin', '2468', '#6366f1', true
where not exists (select 1 from app_users where full_name = 'Chandler Ricks');
