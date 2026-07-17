# FieldRoutes (PestRoutes) API — Capabilities & Integration Plan
*Researched from fieldroutes.dev (official docs) — July 2, 2026. For Pestkee → Growth Booking System.*

## The bottom line

The API covers everything the booking system needs, and more than we planned for. It supports the full lifecycle: **create the customer → create the subscription (the sale) → generate + email the service contract for e-signature → find a real schedule slot → book the appointment onto a tech's route**. Nothing requires manual entry in FieldRoutes.

## 1. Basics

- **Base URL:** `https://{subdomain}.fieldroutes.com/api/{resource}/{action}`
- **Auth:** every request carries `authenticationKey` + `authenticationToken` (a key *pair*, not just one key — confirm you have both). Keys are scoped to **one office** by default; a *global key* can pass any `officeID`. If Pestkee has multiple offices, verify which kind you were issued.
- **Limits:** 3,000 reads + 3,000 writes per office per day, 60 req/min (can be raised via apisupport@fieldroutes.com). Search returns up to 50k IDs; `get` resolves 1,000 entities per call; writes can batch up to 100 entities per request.
- **Pattern:** `search` → IDs, `get` → full objects (`includeData=1` on search resolves the first 1,000 inline).

~198 endpoints across resources including: customer, subscription, contract, document, appointment, spot, route, serviceType, employee, office, ticket (invoices), payment, paymentProfile, note, task, region, changelog, appointmentReminder.

## 2. Booking appointments (the core flow)

FieldRoutes schedules against **spots** — pre-built openings on a tech's route. This is *better* than GHL's calendar model: slots come with a route/tech already attached, so assignment is native.

| Step | Endpoint | Notes |
|---|---|---|
| 1. Find/create customer | `customer/search`, `customer/create` | Full contact + address, `lat`/`lng`, `sourceID` (lead source attribution!), `customerLink` = our external ID (store our Supabase customer UUID here) |
| 2. Availability | `spot/search` | Filter by `date`, `officeIDs`, `apiCanSchedule=1` (only routes API may book). Returns spot IDs → `spot/get` for times/route/tech |
| 3. Hold a slot (optional) | `spot/reserve` | Reserve a spot while the rep finishes the call; returns a bearer token consumed at booking |
| 4. Book | `appointment/create` | `customerID` + `type` (serviceID) required; `spotID`/`routeID` to pin the slot, `start`/`end` window, `duration`, `employeeID`, `notes`, `subscriptionID`, `rejectOccupiedSpots=1` to fail instead of double-book |
| Manage | `appointment/update`, `cancel`, `complete` | Reschedules and cancellations fully supported |

**Maps cleanly to our `AvailabilityProvider` interface:**
- `getAvailability(cfg, start, end)` → `spot/search` + `spot/get`, normalize to `Slot[]` (spot's tech → `assignedRep`, `spotID` → `ref`). Our drive-time filter still applies, though FieldRoutes routes are already geo-clustered.
- `createBooking(cfg, input)` → customer upsert → `appointment/create` with `spotID` from `slot.ref`. `notes`, `assignedUserId` (→`employeeID`), channel/campaign (→`sourceID` mapping) all have homes.
- `spot/reserve` solves the race condition between rep picking a slot and submitting — neither GHL nor ST adapter has this today.

## 3. Generating contracts (yes — natively)

This was the open question and the answer is strong:

- **`contract/create`** — generates the **default contract document for a subscription** and, with `emailCustomer=1`, **emails the customer a signing link** directly from FieldRoutes. Alternatively upload an already-signed PDF (`base64EncodedFile` + `dateSigned`).
- **`document/create`** — upload any supporting file (inspection photos, proposals) to the customer record via base64/multipart. `document/search` to retrieve.
- **`contract/search` / `contract/[id]`** — poll signature status so the booking app can show "contract sent / signed" per customer.

The contract hangs off a **subscription**, so the sale flow is:

1. **`subscription/create`** — the actual "sold deal": `serviceID` + `customerID` required; `initialCharge` + `serviceCharge` (pricing), `frequency` (one-time → recurring), `agreementLength`, `addons`/`initialAddons` (upsell line items), **`soldBy`/`soldBy2`/`soldBy3` (rep commission credit — feeds the time-clock commissions view)**, `sourceID`, preferred days/times/tech.
2. **`contract/create`** with `emailCustomer=1` → customer signs electronically.
3. **`appointment/create`** with `subscriptionID` → initial service scheduled.

Also available: `customer/createPaymentProfile` / `updatePaymentProfile` to store card/ACH + autopay at point of sale (docs show a full "customer + subscription + payment profile" workflow example). Note the prohibition-safe path: we'd send the customer a payment link or let the office collect — we should not have reps type raw card numbers through our app without a tokenized flow; discuss with FieldRoutes support what tokenization options the payment profile endpoints support.

## 4. What this unlocks for the booking system

**Phase 1 — wire the adapter (completes the 5-line vision):**
- New `_shared/fieldroutes.ts` implementing `AvailabilityProvider`; add to `PROVIDERS` map in `availability` + `book` functions (slots already stubbed for this).
- Fill `service_catalog`: `fr_office_id`, `fr_service_type_id` (pull real IDs via `office/search` + `serviceType/search` once the key is in).
- Pestkee goes from **simulated → live** in book.html.

**Phase 2 — sold-customer flow (bigger than what GHL/ST give us):**
- "Sold customer" appointment type triggers subscription + contract + payment profile + initial appointment in one API sequence — a full point-of-sale close from the booking app, with e-sign contract hitting the customer's inbox before the call ends.
- `soldBy` fields give per-rep sales attribution straight in FieldRoutes → commission reporting.

**Phase 3 — reporting/attribution:**
- `sourceID` on customer + subscription = our channel/campaign taxonomy inside FieldRoutes (map our channels to Customer Sources in Admin > Preferences).
- `ticket`/`payment`/`subscription` search endpoints → revenue-per-channel pulls for the marketing dashboard (closes part of the cross-CRM attribution gap).

## 5. Gaps / things to confirm

1. **Key pair + scope** — need `authenticationKey` *and* `authenticationToken`; confirm office scope (single vs global) and that the key has write access to appointment/subscription/contract/document.
2. **`apiCanSchedule` routes** — office must enable API scheduling on routes, or `spot/search` returns nothing bookable. One-time FieldRoutes office setting.
3. **Default contract template** — `contract/create` emails the office's *default* template per service type; template must be set up in FieldRoutes admin first.
4. **serviceID mapping** — need the office's service type IDs (`serviceType/search`) to populate `fr_service_type_id`.
5. **Rate limits** — 3k writes/day is ample for booking volume; only bulk syncs need care.

## Sources

- [FieldRoutes API docs — endpoints](https://fieldroutes.dev/documentation)
- [FieldRoutes API docs — examples & workflows](https://fieldroutes.dev/examples)
- [FieldRoutes API docs — home (limits, key scope)](https://fieldroutes.dev/home)
- [FieldRoutes API docs — FAQ (rate limits)](https://fieldroutes.dev/faq)
