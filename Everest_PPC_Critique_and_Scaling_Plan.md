# Everest Plumbing — Google Ads Critique & $10M → $20M Scaling Plan

Prepared for Advosy Growth · June 2026

---

## The short version

The plan you wrote is a solid, well-organized **emergency-search account** — better than most agencies would hand you. The ad-group-to-landing-page mapping is clean, the budget split is reasonable, and the "optimize for booked jobs, not leads" principle is exactly right.

But as a **plan to double a $10M plumbing company**, it has four structural gaps that will cap your growth:

1. **It's 100% search, but you're already on LSAs.** Local Services Ads are missing from the document entirely, even though they're your highest-ROI Google channel and you're running them. They need to be the centerpiece, not an afterthought.
2. **Everything is exact match.** That hard-caps your volume. You cannot 2x on exact-only — Smart Bidding needs broad/phrase + your conversion data to find the long tail.
3. **You're optimizing to a proxy (60-second calls), not revenue.** You're on ServiceTitan, which can push real booked-job revenue back into Google. Until it does, Smart Bidding is flying blind on what a lead is actually worth. This is the single biggest unlock for scaling profitably.
4. **Search has a demand ceiling.** Total high-intent plumbing searches in your AZ/NV footprint is a fixed pool. Adding budget past a point just raises your CPCs. Breaking $20M needs LSA + Performance Max/Demand Gen + geo expansion + better close rate — not just a bigger search budget.

The rest of this doc walks each campaign, then lays out the scaling path that's modeled in the companion spreadsheet.

---

## What's genuinely good (keep it)

- **Service-specific ad groups → dedicated landing pages.** Burst pipe traffic hitting `/burst-pipe-repair` instead of a generic homepage is what wins Quality Score and conversion rate. Most accounts get this wrong; yours is right.
- **Single-theme ad groups.** Tight keyword-to-ad relevance is the foundation of a cheap CPC. Good.
- **The success metrics.** Cost per booked job, answer rate, close rate, revenue per lead — these are the correct numbers. The problem isn't the targets, it's that you can't *optimize Google toward* them without offline conversion data (see below).
- **Negative keyword discipline.** The starter list is sensible.
- **Network settings.** Search-only on the core campaigns (no Display) is correct.

---

## Campaign-by-campaign critique

### Campaign 1 — Brand Search
**Verdict: keep, but cheap and defensive.** Brand should run on a low-cost bid strategy. "Maximize Conversions" can overpay for clicks you'd win anyway; use a target impression share or a low tCPA and cap it. Its real job is to (a) block competitors conquesting your name and (b) catch "[company] reviews / phone number." Don't let brand's inflated ROAS (30x+ in the model — those customers were already coming) fool you into thinking it's a growth lever. It isn't.

### Campaign 2 — Emergency Plumbing (core)
**Verdict: strong structure, wrong match-type strategy.**

- **Drop exact-only.** Build each ad group as **phrase + broad**, paired with a tCPA Smart Bidding strategy and a strong negative list. Broad match only works when Google has good conversion signals — which is exactly why fixing conversion tracking (below) comes first. Exact-only is a volume ceiling you'll hit fast.
- **Split `plumber near me` out.** It's huge volume but mixed intent (price shoppers, non-emergency). Give it its own ad group so you can bid and message it differently and keep it from polluting your emergency CPA.
- **Use call-only / call ads.** Emergency plumbing is overwhelmingly mobile click-to-call. Run call ads and call assets, not just landing-page traffic. Route through ServiceTitan call tracking so the call *is* the conversion.
- **Add "slab leak," "water heater leaking," "no hot water," "sewage backup."** High-intent, high-ticket, emergency-flavored.

### Campaign 3 — Water Damage & Flood Response
**Verdict: keep it — you fulfill this in-house — but ring-fence it.** Since Everest does the mitigation work, this is real revenue, not a handoff. Two cautions:

- **Different economics.** Restoration jobs are higher-ticket but insurance-driven, longer sales cycle, and competing against restoration giants (much higher CPCs). Track restoration CPA *separately* from plumbing CPA — don't let one blended target hide a problem in either.
- **Insurance-friendly messaging is your edge.** Lean into "we bill your insurance / we document for your claim." That's the conversion driver in this category, more than speed.

### Campaign 4 — General Plumbing Services
**Verdict: good, and underrated for scaling.** This is your *higher-margin, schedulable* work (water heaters, sewer, repipe). Emergency fills trucks today; **planned/high-ticket work is how you grow revenue per job.** As you scale, this campaign should probably grow as a share of budget, not shrink. Add water-heater *replacement* (not just repair) and "tankless water heater install" — big tickets.

### Campaign 5 — Competitor
**Verdict: optional, low priority, do it last.** Conquesting Roto-Rooter et al. is expensive (low Quality Score on their brand terms) and low-converting. Fine as a 5% experiment once everything else is dialed, but it won't move the $20M needle. Don't build it first.

---

## The four things missing that actually matter for $20M

### 1. Local Services Ads (LSA) — make this the centerpiece
You're already running them, but they're absent from the plan. LSAs sit **above** the search ads, are **pay-per-lead** (not per-click), and carry the **Google Guaranteed** badge. For emergency plumbing they're the highest-ROI Google real estate you can buy (~$40–80 per emergency lead vs. $100–200+ CPL on search). The model treats LSA as a ~5x ROAS channel — your best.

LSA ranking is driven by things you control operationally:
- **Review volume + rating.** ~4.8★ is the competitive floor; *volume* matters as much as score. Build a relentless review engine off completed ServiceTitan jobs.
- **Response speed.** Answering LSA leads in under ~2 minutes can lift booking ~60%; sub-15-minute responders book 70%+. Your dispatch/answer process *is* your LSA bid.
- **Hours + proximity.** 24/7 availability ranks you higher on 2 a.m. emergency searches. Profile completeness and service-area accuracy matter.
- **Dispute junk leads.** Reclaim spend on misdialed/spam leads to protect your effective CPL.

### 2. Offline conversion tracking from ServiceTitan — do this before scaling spend
This is the highest-leverage item in the whole plan. ServiceTitan's **Ads Optimizer / Revenue Import** pushes real booked-job revenue (and predicted job value) back into Google Ads as conversion value, and uploads your customer list daily to sharpen targeting. Once that's live you switch core campaigns from **Maximize Conversions → tROAS** and Google starts bidding to *actual dollars*, automatically buying more of the $3,000 restoration jobs and fewer of the $99 unclog calls.

Optimizing to "60-second calls" treats a sewer repipe and a running-toilet call as equal. They're not. This fix is what makes "cost per booked job" an optimizable metric instead of just a reporting metric — and it directly attacks your known cross-CRM attribution problem.

### 3. Geographic strategy
The plan has none. At multi-truck scale across AZ/NV, you want location bid adjustments (or split campaigns) by **metro and by response-time radius** — bid up where you can dispatch fast, down where drive time kills margin. Geo expansion into adjacent zips/metros is also one of the few *clean* ways to add search volume without just inflating CPCs in your core area.

### 4. The reach channels you'll need once Search saturates
Pure search will plateau — there are only so many "emergency plumber" searches per month in your area. To keep growing Google revenue past that ceiling:
- **Performance Max / Demand Gen** (tightly controlled: brand-excluded, audience signals from your customer list, call + form conversions, account-level negatives). Lower efficiency (~2–2.5x in the model) but it extends reach. Test once Search + LSA are maxed.
- **Retargeting + YouTube** to stay top-of-mind for the planned, high-ticket work (water heaters, repipe) where people don't buy on the first click.

---

## Tactical fixes (quick hits)

- **Scaling cadence:** "20–30% every 5–7 days" is fine, but big jumps reset Smart Bidding's learning. Prefer steady ~20% steps and let each stabilize; consider portfolio bid strategies so budget moves don't re-trigger learning per campaign.
- **Negatives to add:** `wholesale`, `supply`, `supplier`, `union`, `rental`, `rebate`, `apprentice`, `wage`, `hourly`. Keep auditing the search-terms report weekly — that's where real money leaks.
- **Conversion hygiene:** dedupe phone + form so you're not double-counting; set booked appointment (from your booking system) as the primary conversion, calls/forms as secondary.
- **Bidding sequence per campaign:** Maximize Conversions to gather data → tCPA once you have ~30 conv/mo → tROAS once ServiceTitan revenue import is feeding value.
- **Landing pages:** sticky click-to-call header, sub-2s load, trust badges (Google Guaranteed, license #, reviews), and the booking widget above the fold. Page speed is conversion rate.

---

## The honest take on $10M → $20M

You will **not** double the company by doubling the Google search budget. Be clear-eyed about that. The realistic path, in priority order:

1. **Fix the plumbing first (weeks 1–4):** ServiceTitan revenue import live, LSA review/speed engine running, call tracking clean. This raises the ROAS of *every dollar* you're already spending before you add a cent.
2. **Scale LSA + Core Search to their efficient ceiling.** These are your 4–5x channels. Push them until cost-per-booked-job starts climbing.
3. **Grow the high-ticket / planned work** (water heaters, sewer, repipe) — this lifts average job value, which lifts ROAS, which lets you afford more spend everywhere.
4. **Add reach channels + geo expansion** to break the search ceiling.
5. **Improve close rate and answer rate** — operational, not media. Going from 30% → 38% booking is the same as a ~25% budget increase, for free.

The companion spreadsheet models a realistic full-scale state: **~$7.1M/yr in Google-attributed revenue on ~$1.76M/yr of Google ad spend (≈4.0x blended ROAS)**, contributing about a third of a $20M company — with the rest coming from Meta, organic/POV content, commercial work, and membership/repeat revenue. Every assumption in it is yours to change; plug in Everest's real avg ticket, close rate, and current CPLs and it will re-forecast.

---

*Benchmark sources: ServiceTitan Ads Optimizer / Revenue Import documentation; 2026 LSA optimization guides for plumbing (lead-cost, review, and response-time benchmarks). Figures are planning assumptions, not guarantees.*
