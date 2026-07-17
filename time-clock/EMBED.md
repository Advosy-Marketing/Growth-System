# Embedding the Time Clock in the Growth Booking System

Two ways to embed, both sharing the same Supabase backend as the full app and the booking
system. Reps clock in/out right inside the booking app, and commissions still post live to
whoever is on the clock.

Files:
- `widget.html` — the compact sidebar widget (the thing that gets embedded)
- `embed.js` — optional one-line floating launcher (button + slide-in panel)

> Replace `https://YOUR-URL/` below with wherever you host these files (e.g. the Vercel URL
> for the `time-clock` folder). `widget.html` and `embed.js` must sit in the same folder.

---

## Option 1 — Inline sidebar (recommended for a fixed sidebar)
Drop this where your sidebar is:

```html
<iframe src="https://YOUR-URL/widget.html"
        style="width:340px;height:600px;border:0;border-radius:16px"
        title="Advosy Time Clock"
        allow="clipboard-write"></iframe>
```

Match your app's look with `?theme=light` (default is dark):

```html
<iframe src="https://YOUR-URL/widget.html?theme=light" ...></iframe>
```

## Option 2 — Floating launcher (one line, no layout changes)
Add near the end of `<body>` in the booking app:

```html
<script src="https://YOUR-URL/embed.js"></script>
```

That adds a floating "Time Clock" button (bottom-right) that opens the widget in a panel.
The button glows green while the rep is on the clock. Options via data-attributes:

```html
<script src="https://YOUR-URL/embed.js"
        data-theme="light"
        data-position="right"
        data-label="Time Clock"></script>
```

---

## Auto-filling the logged-in rep (skip name selection)
The widget always confirms identity with the rep's PIN once (then remembers on that device).
You can pre-select the right person so they only type their PIN:

**Via URL** (if your booking app knows the rep's id):
```html
<iframe src="https://YOUR-URL/widget.html?user_id=REP_UUID"></iframe>
<!-- or -->
<script src="https://YOUR-URL/embed.js" data-user-id="REP_UUID"></script>
```

**Dynamically after login** (floating launcher):
```js
window.AdvosyTimeClock.setRep("REP_UUID");   // pre-selects that rep
window.AdvosyTimeClock.open();               // open the panel
```

`REP_UUID` is the rep's `id` in the `app_users` table — the same id the booking system uses
as `rep_id` on a booking session. If your booking app already tracks the current rep, pass
that id straight through and booking + time clock share one identity.

The launcher API: `window.AdvosyTimeClock.open() / .close() / .toggle() / .setRep(id)`.

---

## Notes
- **Why PIN, not silent SSO:** clock-in is an attestation, so the widget asks for a PIN once
  (validated server-side). After that it's cached on the device, so it's one tap to clock in.
- **Third-party storage:** if a browser blocks storage inside the iframe, the rep just
  re-enters their PIN per session — everything else still works.
- **Realtime:** the widget live-updates "Working now," hours, and commissions via Supabase
  Realtime, same as the full dashboard.
- **Full board link:** the widget's "Open full board" link points at `./index.html`
  (the full dashboard) by default; override with `?full=https://YOUR-URL/`.
