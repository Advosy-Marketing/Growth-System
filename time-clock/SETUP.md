# Advosy Growth — Time Clock + Commissions

A clock-in/out time tracker for the Growth team that shows who's working live, tracks
hours, and **auto-posts commissions** the instant an appointment is booked in the Growth
booking system — tied to whoever is on the clock.

It runs on the **same Supabase project** as the booking system (`advosy-booking`), so
booking and time tracking share one database.

---

## Your login
- **Name:** Chandler Ricks · **Role:** Admin · **PIN:** `2468`
- Change your PIN (and add the team) from the **Admin** tab. Change `2468` first thing.

---

## Use it right now (no hosting needed)
Open `index.html` in any browser (double-click it). It talks to Supabase directly, so it
works fully — clock in/out, live board, realtime — from the local file. Good for testing
and for setting up your team in Admin.

## Publish it for the whole team (≈60 seconds)
Pick one:

**A. Vercel drag-and-drop (easiest)**
1. Go to https://vercel.com/new
2. Drag the `time-clock` folder onto the page (or import it).
3. Vercel gives you a URL like `advosy-time-clock.vercel.app`. Share it with the team.

**B. Vercel CLI**
```
cd "time-clock"
npx vercel deploy --prod
```

**C. Netlify drop**
Go to https://app.netlify.com/drop and drag the `time-clock` folder on.

No build step, no config — it's one static HTML file.

---

## How it works
- **Identity:** each rep picks their name + enters a 4–6 digit PIN. PINs are validated
  server-side by a Supabase Edge Function (`clock`); the browser never gets anyone's PIN.
- **Clock in/out:** writes to the `time_entries` table. One open shift per person.
- **Live board + leaderboard:** Supabase Realtime pushes every clock and commission change
  to all open screens instantly. Week = Monday–Sunday.
- **Commissions (the live link):** a database trigger (`trg_commission_on_insert` /
  `_on_update`) fires whenever a `booking_items` row is booked. It looks up the rep on the
  booking, the commission rate for that **appointment type**, and the rep's **open shift**,
  and inserts a `commissions` row. So a booked appointment shows up as $ on the rep's clock
  and on the leaderboard in real time. If the rep isn't clocked in, the commission still
  records against them (just without a shift link).
- **Commission rates** are editable per appointment type in Admin (defaults: Inspection $25,
  Maintenance $20, Repair/Replace $50, On-site Estimate $35).

## Admin tab (admins/managers)
- Add / edit / remove team members; set their team, role, hourly rate, and PIN.
- Edit commission rates per appointment type.
- Optional hourly rate per rep powers the "Est. pay" figure (hours × rate + commissions).

## What's deployed on Supabase (project `advosy-booking`)
- Tables: `time_entries`, `commissions`, `commission_rates` (+ `role`/`pin`/`hourly_rate`/`color` on `app_users`)
- View: `v_roster` (PIN-safe roster the app reads)
- Trigger: auto-commission on booking
- Edge Functions: `clock` (PIN-validated clock in/out), `admin` (PIN-validated management)
- Realtime enabled on `time_entries`, `commissions`, `app_users`
