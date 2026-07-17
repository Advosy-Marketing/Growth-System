# Advosy Growth — Time Clock + Commissions
## Integration handoff package

A clock-in/out time tracker for the Growth team that shows who's working live, tracks hours,
and **auto-posts commissions the instant an appointment is booked** in the Growth booking
system — tied to whoever is on the clock. It runs on the **same Supabase project** as the
booking system, so booking and time tracking share one database and one rep identity.

**This is what to hand to whoever owns the booking system.** The backend is already live;
the integrator's job is to (1) host the front-end files and (2) drop the widget into the
booking app. Details below.

---

## 1. What's in this package

```
INTEGRATION.md            ← you are here (master guide)
SETUP.md                  ← end-user / admin guide (login, hosting, how it works)
EMBED.md                  ← embedding reference (iframe + launcher + identity)

app/
  index.html              ← full dashboard (My Clock / Team Board / Leaderboard / Admin)

widget/
  widget.html             ← compact sidebar widget (the embeddable piece)
  embed.js                ← one-line floating launcher (button + slide-in panel)
  demo.html               ← local preview: booking page with the widget embedded

backend/
  schema_time_tracking.sql      ← all DB objects (already applied; source of truth)
  functions/clock/index.ts      ← Edge Function: PIN-validated clock in/out
  functions/admin/index.ts      ← Edge Function: PIN-validated management
```

Everything is plain HTML/JS + SQL/TypeScript. No build step, no framework.

---

## 2. Backend (already deployed — reference only)

- **Supabase project:** `advosy-booking` — ref `andzztvmaleiefxcfjwh`
- **Base URL:** `https://andzztvmaleiefxcfjwh.supabase.co`
- **Anon (publishable) key** (safe for the browser):
  `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFuZHp6dHZtYWxlaWVmeGNmandoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3OTA3OTMsImV4cCI6MjA5NzM2Njc5M30.3C9YUDfVmZmLRV__Jd5DBfzr14-zJXsVHJIp8z2u43Y`
- **Endpoints:**
  - `POST /functions/v1/clock` — `{ user_id, pin, action: "in"|"out"|"toggle"|"status" }`
  - `POST /functions/v1/admin` — `{ actor_id, pin, op, payload }`
- **Tables added:** `time_entries`, `commissions`, `commission_rates`; columns
  `role / pin / hourly_rate / color` on `app_users`. View `v_roster` is the PIN-safe roster.
- **Realtime** is enabled on `time_entries`, `commissions`, `app_users`.

The anon key is read-only via RLS; all writes go through the two Edge Functions, which run
with the service-role key and validate PINs server-side. The browser never receives anyone's
PIN or the service-role key.

> If the project's keys are ever rotated, update the two constants (`SUPABASE_URL`, `ANON`) at
> the top of the `<script>` in `app/index.html` and `widget/widget.html`.

---

## 3. The live link to the booking system (most important part)

A database trigger does the work — **no booking-app code change is required** for commissions:

When a row is inserted into `booking_items` (or updated to `status = 'booked'`), the trigger
`create_commission_on_booking()`:
1. reads the rep from the parent `booking_sessions.rep_id`,
2. looks up the commission `amount` for that `appointment_type` in `commission_rates`,
3. finds that rep's currently **open** `time_entries` row (their shift), and
4. inserts a `commissions` row linking the booking, the rep, the shift, and the amount.

So as long as the booking system keeps writing `booking_items` with a `rep_id` on the session
(which it already does), commissions appear live on that rep's clock, the team board, and the
leaderboard. **The one requirement: the `rep_id` on the booking session must be the same
`app_users.id` the rep uses to clock in.** See identity below.

Commission amounts are editable in the Admin tab (defaults: Inspection $25, Maintenance $20,
Repair/Replace $50, On-site Estimate $35).

---

## 4. Integrator steps

### Step A — Host the front-end files
Put `app/`, `widget/` somewhere reachable. Simplest options (no build):
- **Vercel:** drag the package folder onto https://vercel.com/new, or `npx vercel deploy --prod`.
- **Netlify:** drag onto https://app.netlify.com/drop.
- Or serve from the booking system's own static hosting / CDN.

Keep `widget.html` and `embed.js` in the same folder (the launcher resolves the widget URL
relative to its own `<script src>`).

### Step B — Embed the widget in the booking app
Pick one (full reference in `EMBED.md`):

**Inline sidebar:**
```html
<iframe src="https://YOUR-URL/widget/widget.html?theme=light"
        style="width:340px;height:600px;border:0;border-radius:16px"
        title="Advosy Time Clock" allow="clipboard-write"></iframe>
```

**Floating launcher (one line):**
```html
<script src="https://YOUR-URL/widget/embed.js" data-theme="light" data-label="Time Clock"></script>
```

### Step C — Pass the logged-in rep (recommended)
So reps don't pick their name each time, pass their `app_users.id`:
```html
<iframe src="https://YOUR-URL/widget/widget.html?user_id=REP_UUID"></iframe>
<!-- or, with the launcher, after your app knows who's logged in: -->
<script>window.AdvosyTimeClock.setRep("REP_UUID"); // pre-selects that rep</script>
```
The rep confirms with their PIN once, then it's cached on the device. Use the **same id** that
the booking system sets as `booking_sessions.rep_id` so booking + time clock are one identity.

That's it. No backend work — it's already live.

---

## 5. Identity model (why a PIN)

Reps are rows in `app_users` (decoupled from Supabase Auth for low-friction kiosk use). Each
has a 4–6 digit PIN. Clock-in is an attestation, so the widget asks for the PIN once
(validated by the `clock` function), then remembers the rep on that device. Admins/managers
manage reps and PINs in the Admin tab of `app/index.html` (or via the `admin` function).

First admin is seeded: **Chandler Ricks, PIN 2468 — change it immediately.**

---

## 6. Re-deploying backend (only if needed)

The SQL is already applied and the functions are already deployed. If you ever need to
recreate them in another project:
- Run `backend/schema_time_tracking.sql` in the Supabase SQL editor (expects the booking
  system's existing enums/tables — `appointment_type`, `booking_items`, `booking_sessions`,
  `app_users` — to already exist).
- Deploy the two functions with `verify_jwt = false` (auth is the PIN), e.g.
  `supabase functions deploy clock` and `supabase functions deploy admin`.
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically by Supabase.
