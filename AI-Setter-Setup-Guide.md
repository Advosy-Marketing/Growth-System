# AI Appointment Setter & Nurture — Setup Guide

Built on the `advosy-booking` Supabase project. The AI (Claude) works behind the inbound team on the Advosy GHL account (location `z4t41ywW9EayYdtYsUBH`).

**Team-first operating model:** your existing automations send the first touch (offer/campaign-specific) and run their timed cadences. When a customer replies, the AI waits 5 minutes. If a rep answers, the AI stays out entirely. If nobody answers, the AI takes over: it replies, tags the contact `ai-active`, and from then on handles that conversation (instant replies, booking through GHL/ServiceTitan/FieldRoutes, and its own re-engagement follow-ups if the lead goes quiet).

**Required: add an exit condition to your new-lead follow-up automations** so they stop when the tag `ai-active` is added to the contact. That's the collision guard between your cadences and the AI's.

## The one thing you must do before it can talk

Add your Anthropic API key (from console.anthropic.com) to the Supabase Vault:

```sql
select vault.create_secret('sk-ant-...', 'ANTHROPIC_API_KEY');
```

Run that in the SQL editor of the `advosy-booking` project. Everything else is already deployed and tested.

## Endpoint & auth

Webhook URL: `https://andzztvmaleiefxcfjwh.supabase.co/functions/v1/ai-setter/inbound`

Every call must include header `X-AI-Token: d1ab94f1cc52f22700717cb3d16961d63016923090a6f7b9` (or a `token` field in the JSON body — use this in GHL, since GHL custom webhooks make custom headers fiddly).

## GHL wiring — 2 workflows (+1 optional)

### 1. Customer replied → AI safety net (THE core workflow)
- Trigger: **Customer Replied** (filter: SMS and/or Email)
- Action: Custom Webhook → POST to the URL above, body:

```json
{
  "token": "d1ab94f1cc52f22700717cb3d16961d63016923090a6f7b9",
  "event": "message",
  "contact_id": "{{contact.id}}",
  "name": "{{contact.name}}",
  "phone": "{{contact.phone}}",
  "email": "{{contact.email}}",
  "message": "{{message.body}}",
  "channel": "sms",
  "brand": "pestkee"
}
```

Fire it immediately (no wait step). The AI handles the 5-minute wait itself and checks the real conversation thread for a rep reply before doing anything. One workflow covers all brands if you branch to set `brand` (`pestkee`, `vrza`, `everest`, `bloque`, `select_adjusters`); it defaults to `advosy` for contacts it has never seen.

### 2. Appointment no-show → rebooking recovery
- Trigger: Appointment Status = No-show
- Action: Custom Webhook, same body shape with `"event": "no_show"` (no message field needed).
- Touches at 15 min, 1 d, 3 d.

### Optional — AI-owned lead cadence
Your automations keep the first touch. But if you ever want the AI to run the follow-up cadence for a lead source instead of your workflow, send this after your automation's first message goes out:

```json
{ "token": "...", "event": "new_lead", "contact_id": "{{contact.id}}", "brand": "pestkee", "source": "facebook", "first_touch": false }
```

The AI will start its speed-to-lead cadence 45 minutes later (only if the lead still hasn't replied) and stop the moment they engage. Aged reactivation works the same way: `"event": "enroll", "sequence": "aged_reactivation"`.

## How your team stays in control (supervised mode)

Control is by GHL contact tags — no new tools for the team to learn:

- **`ai-off`** — add to any contact to stop the AI touching them.
- **`needs-human`** — the AI adds this itself when it escalates (angry customer, pricing/legal/insurance questions, explicit "I want a human"). It also stops itself. Build a simple GHL workflow on this tag to notify the right team channel.
- **`ai-on`** — add (after removing the above) to hand a contact back to the AI.
- **`ai-active` / `ai-booked` / `ai-opt-out`** — informational tags the AI sets so you can filter and report.

Guardrails baked in: quiet hours 8 pm–8 am Phoenix (proactive sends defer to morning; direct replies always go out), max 6 outbound/contact/day, STOP/unsubscribe honored instantly, never invents pricing or policies, honest if asked whether it's an AI, all bookings recorded in `booking_items` so dashboards and scorecards see them.

## Tuning knobs (SQL, no redeploy needed)

- `ai_settings` — mode (`supervised`/`off`), quiet hours, daily cap, model, `sla_minutes` (rep response window before AI takes over, default 5), `reengage_minutes` (how long the AI waits before nudging a lead who went quiet mid-conversation, default 120).
- `ai_brand_profiles` — persona name, tone, and **`faq`**: paste each brand's pricing ranges, service areas, and common Q&A here. The better the FAQ, the fewer escalations. This is the highest-leverage thing to fill in.
- `nurture_sequences` — edit step timing/goals as JSON.
- `ai_conversations` / `ai_messages` — full transcript log of everything the AI saw and said.

## Booking coverage

- Pest (Pestkee): AI books real FieldRoutes route spots (spot-pinned, no double-booking).
- Roofing (VRZA) + Restoration (Bloque): AI books directly onto GHL calendars.
- HVAC + Plumbing (Everest): AI books via ServiceTitan (lands as a booking for office confirmation).
- Select Adjusters: AI qualifies, collects details, then flags for human scheduling.

## Closing sales (Pestkee)

When a lead explicitly agrees to sign up for recurring service, the AI closes them end to end: it creates the customer and subscription in FieldRoutes with the exact pricing it quoted (sqft-tiered, per-visit charge derived from the plan), FieldRoutes emails the customer the e-sign service agreement, and the AI emails Julia@pestkee.com, Zach@pestkee.com, and Tucker@pestkee.com with the full sale details flagged "needs to be put on the route and subscription finalized." The sale is also recorded in booking_items (appointment_type sold_customer, with annual contract value) so dashboards see it. The AI never promises a first service date; the office confirms that when finalizing the route.

## Daily digest

Every morning at 7:00 AM Phoenix, a summary email goes out (to the MAIL_TO secret, currently chandler@advosy.com): new conversations, messages in/out, appointments booked, accounts sold, escalations with reasons, and opt-outs from the last 24 hours. Change the recipient by adding an AI_DIGEST_TO secret to the Vault. Trigger it manually anytime by POSTing to /ai-setter/digest with the X-AI-Token header.

## Rollout plan (Pestkee first, VRZA last)

Week 1: Pestkee only, Facebook leads, watch `ai_messages` daily. Week 2: Pestkee website forms + replied-lead coverage; add Bloque. Week 3: Everest + no-show recovery. Week 4: VRZA, then consider raising autonomy.
