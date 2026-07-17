# Booking System — Live Integration (GoHighLevel first)

Real Supabase Edge Functions that pull **realtime availability** and create bookings.
GoHighLevel (Roofing + Restoration) is wired now; ServiceTitan and FieldRoutes slot in
behind the same interface next.

## ServiceTitan (Heating & Air + Plumbing) — adapter built & deployed, awaiting credentials
The `servicetitan.ts` adapter is live in both functions behind the same interface
(Capacity API for availability, CRM **Bookings** API for booking — office-confirm flow).
It returns a clear "Missing ServiceTitan secret …" error until you add the credentials.

**1) Add these to Vault** (SQL editor — env vars also work if you prefer the dashboard):
```sql
select vault.create_secret('PASTE','ST_CLIENT_ID');
select vault.create_secret('PASTE','ST_CLIENT_SECRET');
select vault.create_secret('PASTE','ST_APP_KEY');
select vault.create_secret('PASTE','ST_TENANT_ID');
select vault.create_secret('PASTE','ST_BOOKING_PROVIDER_ID');  -- the integration's Booking Provider id in ServiceTitan
-- optional: select vault.create_secret('integration','ST_ENV');  -- to hit the ServiceTitan sandbox instead of production
```

**2) Set the per-line IDs** in `service_catalog`:
```sql
update service_catalog set st_business_unit_id='<HVAC BU>',  st_job_type_id='<HVAC job type>'  where service_type='hvac';
update service_catalog set st_business_unit_id='<PLUMB BU>', st_job_type_id='<PLUMB job type>' where service_type='plumbing';
```

**3) Tell me when done** and I'll probe the live Capacity + Bookings endpoints (via pg_net, using the Vault secrets — values never shown) and adjust the request shapes to match the real responses, the way we did for GoHighLevel. A couple of shapes (capacity body, the booking-provider path, address format) are built to ServiceTitan's documented patterns and will be confirmed against a live call.

## ✅ LIVE DEPLOYMENT (provisioned 2026-06-18)
- **Project:** `advosy-booking`  (ref `andzztvmaleiefxcfjwh`, region us-west-1)
- **API URL:** `https://andzztvmaleiefxcfjwh.supabase.co`
- **Schema:** applied (all tables + RLS + the 5 seeded service lines)
- **Functions (ACTIVE):**
  - `https://andzztvmaleiefxcfjwh.supabase.co/functions/v1/availability`
  - `https://andzztvmaleiefxcfjwh.supabase.co/functions/v1/book`
- **Anon key (JWT) for test calls:** `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFuZHp6dHZtYWxlaWVmeGNmandoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3OTA3OTMsImV4cCI6MjA5NzM2Njc5M30.3C9YUDfVmZmLRV__Jd5DBfzr14-zJXsVHJIp8z2u43Y`

### Status of GoHighLevel wiring
- ✅ **Token** stored in Supabase **Vault** (`GHL_TOKEN`), read via a service-role-only `get_secret()` accessor. (Env vars `GHL_TOKEN` / `GHL_TOKEN_<SERVICE>` also work as a fallback.)
- ✅ **Calendar IDs** set: roofing `E8KENFlRyNkC3ZYLsqVD`, restoration `WivnfahH1Pu5P8AT6Qbq`.
- ✅ **Availability is LIVE** — verified end-to-end: the deployed `availability` function returns real roofing slots (24 on first test).
- ✅ **Location ID** set (shared sub-account `z4t41ywW9EayYdtYsUBH` for both roofing + restoration).
- ✅ **Booking verified** end-to-end — a real test appointment was created and then deleted (clean).

### Important finding — GHL requires an assigned user
This GHL round-robin calendar **rejects appointment creation with HTTP 422 unless `assignedUserId` is provided** (it does *not* auto-assign via the API). The adapter now handles this: if no rep is pinned, it fetches the calendar's team members and picks the **least-loaded** one (counted from our own `booking_items`), giving balanced round-robin that we control — which is also exactly what drive-time-aware assignment needs. Pass `assigned_user_id` on an item to override.

Roofing calendar "Roofing Services Inbound" team members: `NcufyHHmRTODq8JrpK1i`, `bc1vDZhiWvUlgRliO256`.

> Security: the token was pasted in chat — rotate it in GoHighLevel once you're confident everything works, then update the Vault secret (`select vault.update_secret(...)`).

### Quick test once the two steps are done
```bash
curl -s -X POST "https://andzztvmaleiefxcfjwh.supabase.co/functions/v1/availability" \
  -H "Authorization: Bearer sb_publishable_0dEBYD5gLTRAxK_DT8KigQ_atWbel-g" \
  -H "Content-Type: application/json" \
  -d '{"service_type":"roofing","start_date":'$(date +%s000)',"end_date":'$(($(date +%s)+604800))'000,"timezone":"America/Phoenix"}'
```

```
booking-system/
├─ schema.sql                         # apply first (tables + service_catalog config)
├─ supabase/functions/
│  ├─ _shared/
│  │  ├─ providers.ts                 # the one interface all backends implement
│  │  ├─ ghl.ts                       # GoHighLevel v2 adapter (free-slots, contact, appointment)
│  │  ├─ db.ts                        # Supabase client + service_catalog lookup
│  │  └─ driveTime.ts                 # optional drive-time guard (off until MAPS_API_KEY set)
│  ├─ availability/index.ts           # POST → realtime slots for a service line
│  └─ book/index.ts                   # POST → creates customer + session + books each item
└─ scripts/test-ghl.ts               # local smoke test (no deploy needed)
```

## What you need (you said these are ready)
- A **Private Integration token** per sub-account: Roofing and Restoration.
- The **Location ID** and the round-robin **Calendar ID** for each.

## Step 1 — apply the schema
In your Supabase project: run `schema.sql` (SQL editor or `supabase db push`), then fill the
GHL rows of `service_catalog` with your real IDs (replace the `TODO_GHL_*` placeholders):

```sql
update service_catalog set ghl_location_id='<loc>', ghl_calendar_id='<cal>' where service_type='roofing';
update service_catalog set ghl_location_id='<loc>', ghl_calendar_id='<cal>' where service_type='restoration';
```

## Step 2 — fastest proof: local smoke test (no deploy)
Requires [Deno](https://deno.com). Tokens stay on your machine.

```bash
cd booking-system
GHL_TOKEN_ROOFING="pit-xxxxxxxx" \
GHL_CAL="<roofing calendarId>" \
GHL_LOC="<roofing locationId>" \
deno run --allow-net --allow-env scripts/test-ghl.ts
```

You should see real open slots printed from GoHighLevel. That confirms the connection end-to-end.

## Step 3 — deploy the functions
Requires the [Supabase CLI](https://supabase.com/docs/guides/cli), linked to your project.

```bash
cd booking-system
# secrets (per sub-account token) — never commit these
supabase secrets set GHL_TOKEN_ROOFING="pit-xxxx" GHL_TOKEN_RESTORATION="pit-yyyy"
# SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically in Edge Functions

supabase functions deploy availability
supabase functions deploy book
```

### Test availability (deployed)
```bash
curl -s -X POST "https://<project-ref>.supabase.co/functions/v1/availability" \
  -H "Authorization: Bearer <SUPABASE_ANON_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"service_type":"roofing","start_date":'$(date +%s000)',"end_date":'$(($(date +%s)+604800))'000,"timezone":"America/Phoenix"}'
```

### Test a booking (deployed)
```bash
curl -s -X POST "https://<project-ref>.supabase.co/functions/v1/book" \
  -H "Authorization: Bearer <SUPABASE_ANON_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "session": {"customer":{"name":"Jane Homeowner","phone":"4805550199","address":"123 Desert Ln, Mesa AZ"},
                "source":"inbound","channel":"meta_ads","campaign":"high_intent"},
    "items": [{"service_type":"roofing","appointment_type":"inspection",
               "slot":{"start":"2026-06-22T09:00:00-07:00","end":"2026-06-22T10:30:00-07:00"}}]
  }'
```

## Notes
- **Round-robin:** omit `assigned_user_id` and GHL assigns the rep. Pass it to pin a specific
  (e.g. drive-time-validated) rep — see the round-robin note in the build plan.
- **Drive-time guard:** off until you set `MAPS_API_KEY` (+ `MAPS_PROVIDER`). The hook is in
  `_shared/driveTime.ts`; availability works fine without it.
- **Versions:** calendars use the `2021-04-15` API version, contacts use `2021-07-28` (handled in `ghl.ts`).
- **Rate limits:** GHL v2 allows ~100 requests / 10s. Availability is one call per service line.
- **Wiring the next backend:** implement the same `AvailabilityProvider` interface in
  `_shared/servicetitan.ts` / `_shared/fieldroutes.ts` and add it to the `PROVIDERS` map in both functions.
```
