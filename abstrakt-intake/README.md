# Abstrakt → GoHighLevel — setup & go-live

**Status:** ✅ Edge function `abstrakt-intake` deployed (v3). ✅ Log/idempotency table `abstrakt_intake` created (RLS locked). ✅ All secrets set (token, location `o5Zladrmv1i427YXoDo9`, calendar `OAAA5V0aArPqtabjI13r` "Commercial HVAC Appointments", rep Neil Chrisney `2XqADhNZli1NOrMesUwe`, rep + manager phones, webhook secret). ✅ Parser validated on a real Abstrakt email (incl. Arizona-time fix). ⏳ **Only remaining step: build the GHL workflow trigger (Step 3, Option A).**

Webhook secret (for the GHL workflow header): `abk_live_9f3kQ2mZ7pR4tX8vL1nD6bH0`

Function URL: `https://andzztvmaleiefxcfjwh.supabase.co/functions/v1/abstrakt-intake`

---

## Step 1 — Validate the parser (no secrets needed yet)

The function has a **dry-run** mode that only parses and shows what it extracted + the SMS it would send. It needs just one secret: `ANTHROPIC_API_KEY` (in Supabase → Project Settings → Edge Functions → Secrets, or Vault).

Then paste a real Abstrakt email through it:

```bash
curl -s "https://andzztvmaleiefxcfjwh.supabase.co/functions/v1/abstrakt-intake?dryRun=1" \
  -H "Content-Type: application/json" \
  -d '{
    "subject": "New Appointment - Acme HVAC",
    "from": "notifications@abstraktmarketing.com",
    "text": "PASTE THE FULL EMAIL BODY HERE"
  }'
```

It returns the parsed `leadName`, `businessName`, `contactPhone`, appointment time, `notes`, and `voiceRecordingUrl`, plus `wouldSendSms`. If any field looks off, send me the sample and I'll tune the extraction. **Easiest path: just forward me one real Abstrakt email and I'll run this for you.**

## Step 2 — Set the go-live secrets

In Supabase → Project Settings → Edge Functions → Secrets (or your Vault, since the function reads both):

| Secret | What it is |
|---|---|
| `ABSTRAKT_WEBHOOK_SECRET` | Any random string. Must match the Apps Script. |
| `ANTHROPIC_API_KEY` | For parsing (same key ai-setter uses). |
| `GHL_TOKEN_EVEREST` | Everest GHL API token (falls back to shared `GHL_TOKEN`). |
| `EVEREST_GHL_LOCATION_ID` | Everest sub-account / location id. |
| `EVEREST_GHL_CALENDAR_ID` | Calendar the appointments land on. |
| `EVEREST_GHL_REP_USER_ID` | The fixed rep's GHL user id (gets the appointment + GHL notification). |
| `ABSTRAKT_REP_PHONE` | Rep's cell for SMS. |
| `ABSTRAKT_MANAGER_PHONES` | Manager cells, comma-separated. |
| `ABSTRAKT_EXPECTED_SENDER` | *(optional)* e.g. `abstraktmarketing.com` — rejects anything not from them. |
| `ABSTRAKT_TZ` | *(optional)* defaults to `America/Phoenix`. |
| `ABSTRAKT_APPT_DURATION_MIN` | *(optional)* defaults to `30`. |

## Step 3 — Capture the emails (pick one)

**Option A — GHL-native (recommended, keeps everything in GHL):**

1. In the Business Development sub-account, create a contact whose **email = `autoappointments@abstraktmg.com`** (the "Abstrakt carrier" contact).
2. Route the Abstrakt emails into GHL so they land on that contact's conversation (forward `autoappointments@abstraktmg.com` mail from chandler@advosy.com into the sub-account's inbound email address).
3. Build a Workflow:
   - **Trigger:** Inbound email / "Customer Replied" (Channel: Email), filtered to the Abstrakt carrier contact.
   - **Action:** Webhook → `POST https://andzztvmaleiefxcfjwh.supabase.co/functions/v1/abstrakt-intake`
     - Custom header `x-abstrakt-secret: <ABSTRAKT_WEBHOOK_SECRET>`
     - JSON body: `{ "emailMessageId": "{{message.id}}" }` (the function pulls the full email body back from the GHL API by that id, so nothing gets truncated).

**Option B — Gmail Apps Script (fallback):** open `apps-script.gs`, follow its SETUP comment, paste into a Google Apps Script project signed into chandler@advosy.com, set `WEBHOOK_SECRET` + `SEARCH_QUERY`, run `setup()` then `testOne()`.

## Step 4 — Go live

Once secrets are set and a real email flows, the appointment appears in GHL assigned to the rep, and the rep + managers get a text. Every run is logged in the `abstrakt_intake` table (`status` = success / failed / duplicate). Failed intakes also text the managers so nothing is ever silently dropped.

---

## How it behaves

- **Idempotent** — same email won't double-book (deduped on Gmail message id).
- **Time handling** — if the email states a clear meeting time it's used; if not, a next-day 9am placeholder is set and the appointment title + description are flagged `⚠ CONFIRM TIME`, and the SMS says `TIME TBD`.
- **Recording link** — goes into the appointment description, the contact note, and the SMS.
- **Safe by default** — the function is inert until it receives an authenticated POST; missing secrets just make it error (and alert), never misfire.
