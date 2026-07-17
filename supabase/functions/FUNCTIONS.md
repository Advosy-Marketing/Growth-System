# Deployed Edge Functions — advosy-booking (project andzztvmaleiefxcfjwh)

Pulled from the live project on 2026-07-17. Standard Supabase CLI layout:
each function's entrypoint is `supabase/functions/<slug>/index.ts`; shared
modules live in `supabase/functions/_shared/`.

| slug | verify_jwt | entrypoint |
|---|---|---|
| availability | false | supabase/functions/availability/index.ts |
| book | false | supabase/functions/book/index.ts |
| clock | false | supabase/functions/clock/index.ts |
| admin | false | supabase/functions/admin/index.ts |
| daily-report | false | supabase/functions/daily-report/index.ts |
| marketing | false | supabase/functions/marketing/index.ts |
| thumbtack-webhook | false | supabase/functions/thumbtack-webhook/index.ts |
| opportunities | false | supabase/functions/opportunities/index.ts |
| ghl-calls-sync | false | supabase/functions/ghl-calls-sync/index.ts |
| st-lookup | false | supabase/functions/st-lookup/index.ts |
| places | false | supabase/functions/places/index.ts |
| fr-lookup | true | supabase/functions/fr-lookup/index.ts |
| ai-setter | false | supabase/functions/ai-setter/index.ts |
| campaigns | false | supabase/functions/campaigns/index.ts |
| campaign-ai | false | supabase/functions/campaign-ai/index.ts |
| higgsfield | false | supabase/functions/higgsfield/index.ts |
| meta-push | false | supabase/functions/meta-push/index.ts |
| brand-assets | false | supabase/functions/brand-assets/index.ts |
| nano-banana | false | supabase/functions/nano-banana/index.ts |
| assignees | false | supabase/functions/assignees/index.ts |
| rep-availability | false | supabase/functions/rep-availability/index.ts |

Deploy example: `supabase functions deploy <slug> --no-verify-jwt` (all except
fr-lookup, which is deployed with verify_jwt enabled).

## Important notes from the pull

1. `_shared/providers.ts` (type definitions: Provider, ServiceConfig, Slot,
   BookingInput, BookingResult, CustomerInput, AvailabilityProvider,
   ServiceType) is imported by _shared modules and several functions but was
   NOT included in any deployed bundle (type-only imports are stripped at
   bundle time). It must be recreated before local type-checking / redeploy.

2. `_shared` version conflicts (different functions were deployed with
   different copies of the same shared file):
   - `_shared/ghl.ts`: kept the `book` version (superset: provider +
     markOpportunityWon). The `assignees` bundle carried a different slice
     containing `listGhlAssignees` (preserved verbatim at
     `assignees/_ghl.assignees-deployed-variant.ts`); merge `listGhlAssignees`
     into `_shared/ghl.ts` before redeploying `assignees`.
   - `_shared/fieldroutes.ts`: kept the `book` version (newest core logic:
     contractLink capture, FR plan-by-frequency serviceID mapping, spot-booking
     duration fix). The `ai-setter` bundle carried a diverged variant adding
     `frUpsertLead`, `frCreateNote`, `frListSubscriptions`, `frGetCustomer`
     (preserved verbatim at
     `ai-setter/_fieldroutes.ai-setter-deployed-variant.ts`); merge those four
     exports into `_shared/fieldroutes.ts` before redeploying `ai-setter`.
   - `_shared/servicetitan.ts`: kept the `book`/`availability` version. The
     `ai-setter` bundle's copy differed only in the booking externalId prefix
     (`advosy-ai-` instead of `advosy-`) and a header comment.
   - `_shared/db.ts` and `_shared/audit.ts`: identical across bundles.

3. The helper variant files prefixed with `_` are archival copies of what was
   actually deployed; they are not imported by anything.
