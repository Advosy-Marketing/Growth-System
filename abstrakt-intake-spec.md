# Abstrakt → GoHighLevel Appointment Pipeline

**Goal:** When Abstrakt Marketing emails a new Everest appointment, automatically create it in GoHighLevel, assign it to the sales rep, and notify the rep + sales managers by SMS — no manual re-keying.

**Build decision:** Extend the existing Supabase edge-function stack (project `Advosy-Booking`). Reuses code already in production.

---

## How it works (end to end)

1. **Capture** — Abstrakt sends its notification email to the work inbox. A small trigger in that inbox forwards the raw email to a new Supabase edge function (`abstrakt-intake`).
2. **Parse** — the function pulls the lead's name, business, contact info, appointment notes, and the voice-recording link out of the email.
3. **Create in GHL** — upserts the contact in the Everest GHL location and creates the appointment on the chosen calendar, assigned to the fixed sales rep. The voice-recording link + all notes go into the appointment description and a contact note.
4. **Notify** — sends an SMS to the assigned rep and to the sales managers with the lead details + recording link. Assigning the appointment to the rep in GHL also fires GHL's own internal new-appointment notification.
5. **Log** — every run is written to `audit_log` so nothing silently fails.

```
Abstrakt email → work inbox → [trigger] → abstrakt-intake (Supabase)
                                              ├─ parse email
                                              ├─ GHL: upsert contact + create appointment (assigned to rep)
                                              ├─ SMS rep + sales managers (GHL conversations/messages)
                                              └─ audit_log
```

## What I'm reusing from your stack

- **`_shared/ghl.ts`** — the same GHL v2 adapter your `book` function uses: `contacts/upsert`, `calendars/events/appointments`, contact notes, `assignedUserId`.
- **`sendSmsToPhone(phone, message)`** from `ai-setter/comms.ts` — upserts a contact by phone and sends SMS via GHL `conversations/messages`. Your Pestkee "sold" notification already blasts a list of phones this exact way; I'll mirror it for rep + managers.
- **`audit_log`** table for run history.

## Email capture — recommended approach

The Abstrakt emails land in a work inbox (not chandler.ricks1@gmail.com), so we need to get each new email to the edge function. Recommended: a **Google Apps Script** bound to that inbox that runs on a 1-minute trigger, finds new emails from Abstrakt's sender address, POSTs the raw body to `abstrakt-intake`, and labels them "Processed." Free, always-on, and keeps the logic in Supabase per your choice. (Alternatives: an inbound email-parse service like Mailgun/CloudMailin, or connecting the inbox here and polling — both workable, but Apps Script is the cleanest.)

## Notifications

- **SMS to assigned rep** — full lead details + voice-recording link.
- **SMS to sales managers** — same summary, for visibility.
- **GHL internal notification** — automatic once the appointment is assigned to the rep's GHL user.

---

## What I need from you to build it

1. **A real Abstrakt notification email** — forward or paste one full example (with the lead info, contact method, notes, and the voice-recording link). This is the one true blocker: the parser is written against the actual format.
2. **The work inbox** — which address receives these, and is it Google Workspace or Outlook? (Determines the capture trigger.)
3. **Everest GHL** — the location/sub-account ID, the API token to use (e.g. a `GHL_TOKEN_EVEREST`), and the **calendar ID** appointments should land on.
4. **The sales rep** — their GHL user (name/email or user ID) and cell number.
5. **Sales manager cell numbers** — who else gets the SMS.
6. **SMS sending number** — which Everest/Twilio number in GHL these texts should come from (usually the location default).

Once I have #1–#3 I can build and deploy; #4–#6 wire up the assignment and notifications.

---

## Note / security flag

Two tables in the Booking project have Row Level Security disabled — `ghl_owner_assignments` and `appt_migration_log` — meaning anyone with the anon key can read/modify them. Not blocking this pipeline, but worth locking down separately.
