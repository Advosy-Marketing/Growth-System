# Advosy Growth - Developer Handoff

Everything needed to run, move, or absorb this system into a larger project.
Exported from the live Supabase project `andzztvmaleiefxcfjwh` (Advosy-Booking) on 2026-07-17.

## What this system is

A unified Growth department platform for Advosy's brands (VRZA, Everest, Pestkee, Bloque, Select Adjusters):

- **Booking system**: `book.html` + widget/embed. Books appointments across 5 service lines, routing to ServiceTitan, GoHighLevel, or FieldRoutes depending on brand.
- **Time clock**: `time-clock/` frontends. Clock in/out with live commission calculations.
- **Admin/marketing dashboards**: `admin-report.html`, `advosy-dashboard/`.
- **AI setter**: Claude-powered SMS/email agent (`ai-setter` function) with nurture cron.
- **Ad creative pipeline**: `campaigns`, `campaign-ai`, `nano-banana`, `higgsfield`, `meta-push`, `brand-assets` functions.

## Repo layout

| Path | What it is |
|---|---|
| `supabase/` | **Canonical, deployable source of truth.** Pulled from the live deployed project on 2026-07-17. |
| `supabase/functions/` | All 21 deployed edge functions + `_shared/` libs. See `supabase/functions/FUNCTIONS.md` for the verify_jwt flag per function. |
| `supabase/schema.sql` | Full database DDL: 39 tables, 7 enums, RLS, 4 functions, triggers, indexes. Applies cleanly to an empty project. |
| `supabase/cron_jobs.sql` | 7 pg_cron jobs. **URLs and anon key placeholders must be updated for a new project.** |
| `supabase/storage_buckets.sql` | Buckets `brand-assets` and `creatives` (both public). |
| `booking-system/`, `time-clock/` | Historical working copies. Where they conflict with `supabase/`, trust `supabase/`. |
| Root HTML files, `advosy-dashboard/` | Frontends. Supabase URL + anon key are constants near the top of each file. |

## Standing this up on a new Supabase project

1. `supabase link --project-ref <NEW_REF>`
2. Apply `supabase/schema.sql` (SQL editor or `psql`). It includes extensions (uuid-ossp, pgcrypto, pg_cron, pg_net), tables, RLS, and the `verify_pin` / `hash_pin` / `get_secret` / `create_commission_on_booking` functions.
3. Apply `supabase/storage_buckets.sql`.
4. Deploy functions: `supabase functions deploy <slug> --no-verify-jwt` for every slug EXCEPT `fr-lookup` (deploy that one with JWT verification on). Flags per function are in `FUNCTIONS.md`.
5. Set secrets (`supabase secrets set KEY=value`). Full list below.
6. Edit `supabase/cron_jobs.sql`: replace the old project ref in URLs and the `REPLACE_WITH_NEW_PROJECT_ANON_KEY` placeholders, then run it.
7. Update frontends: swap Supabase URL + anon key constants in `book.html`, `widget.html`, `index.html`, `admin-report.html`, `advosy-dashboard/*`, `time-clock/*`, `embed.js`.
8. Re-point external callers (see "External integrations" below).
9. Migrate data if history matters: `pg_dump` from old project, restore to new. Storage bucket files must be copied separately.

## Secrets required

Values are NOT in this repo, by design. They live in Supabase function secrets and Vault. Whoever sets up a new environment needs to gather these:

| Secret | Service / where to get it |
|---|---|
| `GHL_TOKEN`, `GHL_TOKEN_<SERVICE_TYPE>` (per line, e.g. `GHL_TOKEN_PEST_CONTROL`), `GHL_LOCATION_ID`, `GHL_LOC`, `GHL_CAL` | GoHighLevel: private integration tokens per sub-account |
| `ST_CLIENT_ID`, `ST_CLIENT_SECRET`, `ST_APP_KEY`, `ST_TENANT_ID`, `ST_BOOKING_PROVIDER_ID`, `ST_ENV`, `ST_TZ` | ServiceTitan developer portal |
| `FR_SUBDOMAIN`, `FR_AUTH_KEY`, `FR_AUTH_TOKEN` | FieldRoutes account settings |
| `MAPS_API_KEY`, `MAPS_PROVIDER`, `GOOGLE_PLACES_KEY` | Google Cloud console |
| `ANTHROPIC_API_KEY` | Anthropic console (AI setter, campaign AI) |
| `GEMINI_API_KEY` | Google AI Studio (nano-banana image gen) |
| `HIGGSFIELD_KEY_ID`, `HIGGSFIELD_KEY_SECRET` | Higgsfield account |
| `RESEND_API_KEY`, `MAIL_FROM`, `MAIL_TO`, `AI_DIGEST_TO` | Resend (email delivery) |
| `WINDSOR_API_KEY` | Windsor.ai (marketing data) |
| `THUMBTACK_WEBHOOK_TOKEN`, `AI_WEBHOOK_TOKEN`, `CRON_SECRET` | Internal shared secrets, generate new random values and update callers |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Auto-provided by Supabase |

Note: many secrets are read env-first with a `get_secret()` Vault fallback. Setting them as plain function secrets is sufficient on a new project.

## External integrations that point at the project URL

If the project ref changes, these must be updated at the source:

- **GHL workflows** calling `ai-setter` and related endpoints
- **Thumbtack webhook** subscription pointing at `/functions/v1/thumbtack-webhook`
- **Cron jobs** (handled via `cron_jobs.sql`)
- **Any embeds** of `book.html` / `widget.html` / `embed.js` on brand websites

## Known TODOs before redeploying two functions

The deployed bundles contained diverged copies of two `_shared` files. Canonical copies are in `_shared/`, the diverged extras are preserved as variant files:

1. `assignees` needs `listGhlAssignees` merged from `assignees/_ghl.assignees-deployed-variant.ts` into `_shared/ghl.ts`.
2. `ai-setter` needs `frUpsertLead`, `frCreateNote`, `frListSubscriptions`, `frGetCustomer` merged from `ai-setter/_fieldroutes.ai-setter-deployed-variant.ts` into `_shared/fieldroutes.ts`.

Until merged, deploy those two functions with their variant files, or do the merge first. All other functions deploy as-is.

## Hardcoded values worth reviewing

- GHL location fallback `z4t41ywW9EayYdtYsUBH` in `_shared/ghl.ts`, `ghl-calls-sync`, `ai-setter/comms.ts` (overridable via `GHL_LOCATION_ID`)
- Meta ad account fallback `1650188606120291` in `meta-push`
- Pestkee sold-notification contacts (emails + phone numbers) in `ai-setter/booking.ts`
- Report email fallback `chandler@advosy.com` in `daily-report` and `ai-setter`

## The zero-migration alternative

Instead of standing up a new project, the existing project can be transferred whole: Supabase dashboard > project Settings > General > Transfer project to another organization. Database, data, functions, secrets, and URLs all stay intact, so frontends and external webhooks keep working with no changes. If the goal is just moving ownership to a company account, this is the recommended path.
