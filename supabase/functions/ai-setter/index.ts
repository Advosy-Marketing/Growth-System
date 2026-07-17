// =====================================================================
// AI Appointment Setter & Lead Nurture — Advosy Growth (team-first mode)
// Routes: /inbound, /tick (1 min), /digest (daily), /fr-sync (hourly:
//   FieldRoutes subscription lifecycle -> GHL tags, runs even when AI off)
// Lifecycle tags: pestkee-lead / pestkee-pending / pestkee-active /
//   pestkee-paused / pestkee-inactive. Contacts tagged active|paused are
//   CUSTOMERS: the AI never engages them (customer-success team owns them).
// FieldRoutes rate-limit posture (3000 reads + 3000 writes/day, 60/min):
//   fr-sync caps at 40 customers + 110s per run; per-lead/per-sale calls
//   are single-digit; total steady-state usage is a few hundred calls/day.
// =====================================================================

import { admin, getServiceConfig } from "../_shared/db.ts";
import { runAgent } from "./agent.ts";
import { sendMessage, addTags, removeTags, getContactDetails, getSecret, getRecentMessages, sendInternalEmail, ghlUpsertContact } from "./comms.ts";
import { frUpsertLead, frCreateNote, frListSubscriptions, frGetCustomer } from "../_shared/fieldroutes.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ai-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const OPT_OUT_RE = /^\s*(stop|stopall|unsubscribe|quit|cancel|end|remove me)\b/i;
const KNOWN_BRANDS = ["pestkee", "vrza", "everest", "bloque", "select_adjusters"];
const CUSTOMER_TAGS = ["pestkee-active", "pestkee-paused"]; // AI never engages these

async function getSettings(db: any) {
  const { data } = await db.from("ai_settings").select("*").eq("id", 1).single();
  return data ?? { mode: "supervised", quiet_start: 21, quiet_end: 7, timezone: "America/Phoenix", max_msgs_per_day: 6, model: "claude-sonnet-5", sla_minutes: 5, reengage_minutes: 120, takeover_until: null };
}

function oooActive(st: any): boolean {
  return !!(st.takeover_until && Date.parse(st.takeover_until) > Date.now());
}

function hourIn(tz: string): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(new Date()));
}
function sendAllowedNow(st: any): boolean {
  const h = hourIn(st.timezone);
  return h >= st.quiet_end && h < st.quiet_start;
}
function nextAllowedTime(st: any): Date {
  const now = new Date();
  const h = hourIn(st.timezone);
  const addH = h >= st.quiet_start ? (24 - h) + st.quiet_end : (h < st.quiet_end ? st.quiet_end - h : 0);
  return new Date(now.getTime() + Math.max(addH, 0) * 3600_000 + 5 * 60_000);
}

function thumbtackBrand(company: string | null | undefined): string | null {
  const c = String(company ?? "").toLowerCase();
  if (!c) return null;
  if (c.includes("pest")) return "pestkee";
  if (c.includes("everest")) return "everest";
  if (c.includes("vrza") || c.includes("construction") || c.includes("roof")) return "vrza";
  if (c.includes("bloque") || c.includes("restor")) return "bloque";
  if (c.includes("select") || c.includes("adjust")) return "select_adjusters";
  if (KNOWN_BRANDS.includes(c)) return c;
  return null;
}

async function upsertConversation(db: any, p: any) {
  const name = p.name || [p.first_name, p.last_name].filter(Boolean).join(" ") || null;
  const channel = p.channel === "email" ? "email" : (p.phone ? "sms" : (p.email ? "email" : "sms"));
  const patch: Record<string, unknown> = {
    ghl_contact_id: p.contact_id,
    updated_at: new Date().toISOString(),
  };
  if (name) patch.contact_name = name;
  if (p.phone) patch.contact_phone = p.phone;
  if (p.email) patch.contact_email = p.email;
  if (p.brand && KNOWN_BRANDS.includes(String(p.brand))) patch.brand = p.brand;
  if (p.source) patch.lead_source = p.source;
  if (p.campaign) patch.campaign = String(p.campaign);

  const { data: existing } = await db.from("ai_conversations").select("*").eq("ghl_contact_id", p.contact_id).maybeSingle();

  const effectiveBrand = (patch.brand as string) ?? existing?.brand ?? "advosy";
  if (effectiveBrand === "advosy") {
    try {
      const digits = String(p.phone ?? existing?.contact_phone ?? "").replace(/\D/g, "").slice(-10);
      if (digits.length === 10) {
        const { data: tt } = await db.from("thumbtack_leads").select("company")
          .like("phone", `%${digits}`).order("received_at", { ascending: false }).limit(1);
        const inferred = thumbtackBrand(tt?.[0]?.company);
        if (inferred) patch.brand = inferred;
      }
    } catch { /* best effort */ }
  }

  if (existing) {
    const { data } = await db.from("ai_conversations").update(patch).eq("id", existing.id).select().single();
    return data;
  }
  const { data, error } = await db.from("ai_conversations")
    .insert({ ...patch, channel, status: "active", owner: "team" }).select().single();
  if (error) throw new Error(`ai_conversations insert: ${error.message}`);
  return data;
}

// Tag-driven state: customer tags always win; then ai-off/needs-human; then ai-on.
async function syncTakeoverState(db: any, conv: any): Promise<any> {
  let tags: string[] = [];
  try { const c = await getContactDetails(conv.ghl_contact_id); tags = c.tags; } catch { return conv; }
  const low = tags.map((t) => t.toLowerCase());

  const isCustomer = low.some((t) => CUSTOMER_TAGS.includes(t));
  if (isCustomer && conv.status !== "customer" && conv.status !== "opted_out") {
    const { data } = await db.from("ai_conversations").update({ status: "customer", owner: "team", updated_at: new Date().toISOString() }).eq("id", conv.id).select().single();
    return data ?? conv;
  }
  if (!isCustomer && conv.status === "customer") {
    const { data } = await db.from("ai_conversations").update({ status: "active", updated_at: new Date().toISOString() }).eq("id", conv.id).select().single();
    conv = data ?? conv;
  }

  const off = low.includes("ai-off") || low.includes("needs-human");
  const on = low.includes("ai-on");
  if (off && conv.status === "active") {
    const { data } = await db.from("ai_conversations").update({ status: "human", updated_at: new Date().toISOString() }).eq("id", conv.id).select().single();
    return data;
  }
  if (on && !off && conv.status === "human") {
    const { data } = await db.from("ai_conversations").update({ status: "active", flagged_reason: null, updated_at: new Date().toISOString() }).eq("id", conv.id).select().single();
    return data;
  }
  return conv;
}

async function humanRepliedSince(db: any, conv: any, sinceIso: string): Promise<boolean> {
  try {
    const { messages } = await getRecentMessages(conv.ghl_contact_id);
    const { data: ours } = await db.from("ai_messages").select("meta")
      .eq("conversation_id", conv.id).eq("direction", "outbound").order("created_at", { ascending: false }).limit(30);
    const ourIds = new Set<string>();
    for (const r of (ours ?? [])) {
      const g = (r as any).meta?.ghl ?? {};
      for (const k of ["messageId", "emailMessageId", "id", "msgId"]) if (g?.[k]) ourIds.add(String(g[k]));
      if (g?.msg?.id) ourIds.add(String(g.msg.id));
    }
    const since = Date.parse(sinceIso) - 60_000;
    for (const m of (messages ?? [])) {
      if (String(m?.direction ?? "").toLowerCase() !== "outbound") continue;
      const t = Date.parse(m?.dateAdded ?? "");
      if (!(t > since)) continue;
      const mt = String(m?.messageType ?? "");
      if (mt && !/SMS|EMAIL/i.test(mt)) continue;
      if (!ourIds.has(String(m?.id ?? ""))) return true;
    }
    return false;
  } catch {
    return true;
  }
}

async function logMsg(db: any, convId: string, direction: string, channel: string, body: string, ai = false, meta: any = {}) {
  await db.from("ai_messages").insert({ conversation_id: convId, direction, channel, body, ai_generated: ai, meta });
}

async function buildHistory(db: any, conv: any, tz: string) {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  let hist: { direction: string; body: string }[] = [];
  try {
    const { messages } = await getRecentMessages(conv.ghl_contact_id);
    const comms = (messages ?? [])
      .filter((m: any) => {
        const mt = String(m?.messageType ?? "");
        const hasBody = !!(m?.body && String(m.body).trim());
        return hasBody && (!mt || /SMS|EMAIL|FB|IG|GMB|CHAT|WHATSAPP/i.test(mt));
      })
      .sort((a: any, b: any) => Date.parse(a?.dateAdded ?? 0) - Date.parse(b?.dateAdded ?? 0))
      .slice(-40);
    hist = comms.map((m: any) => ({
      direction: String(m.direction ?? "").toLowerCase() === "inbound" ? "inbound" : "outbound",
      body: `[${fmt.format(new Date(m.dateAdded))}] ${String(m.body).trim()}`,
    }));
  } catch (e) {
    console.error("GHL history fetch failed, falling back to local log:", e);
  }
  if (hist.length === 0) {
    const { data } = await db.from("ai_messages").select("direction, body, created_at")
      .eq("conversation_id", conv.id).order("created_at", { ascending: false }).limit(30);
    hist = (data ?? []).reverse().map((m: any) => ({
      direction: m.direction,
      body: `[${fmt.format(new Date(m.created_at))}] ${m.body}`,
    }));
  }
  try {
    const { data: lastIn } = await db.from("ai_messages").select("body, created_at")
      .eq("conversation_id", conv.id).eq("direction", "inbound")
      .order("created_at", { ascending: false }).limit(1);
    const li = lastIn?.[0];
    if (li) {
      const tail = hist.slice(-4).map((h) => h.body).join("\n");
      const probe = String(li.body).trim().slice(0, 60);
      if (probe && !tail.includes(probe)) {
        hist.push({ direction: "inbound", body: `[${fmt.format(new Date(li.created_at))}] ${li.body}` });
      }
    }
  } catch { /* best effort */ }
  return hist;
}

async function buildLeadInfo(db: any, conv: any): Promise<string> {
  const parts: string[] = [];
  try {
    const c = await getContactDetails(conv.ghl_contact_id);
    const bits: string[] = [];
    if (c.source) bits.push(`CRM source: ${c.source}`);
    if (c.dateAdded) bits.push(`Contact created: ${c.dateAdded}`);
    if (c.address) bits.push(`Address on file: ${c.address}`);
    for (const f of (c.customFields ?? [])) {
      const v = typeof f?.value === "string" ? f.value : JSON.stringify(f?.value ?? "");
      if (v && v.length < 400) bits.push(`${f?.name ?? f?.id ?? "field"}: ${v}`);
    }
    if (bits.length) parts.push("CRM contact info:\n" + bits.join("\n"));
  } catch { /* best effort */ }

  try {
    const digits = String(conv.contact_phone ?? "").replace(/\D/g, "").slice(-10);
    if (digits.length === 10) {
      const { data: tt } = await db.from("thumbtack_leads")
        .select("company, service_category, lead_type, lead_created, raw")
        .like("phone", `%${digits}`)
        .order("received_at", { ascending: false }).limit(1);
      const row = tt?.[0];
      if (row) {
        const req = row.raw?.data?.request ?? {};
        const qa = (req.details ?? []).map((d: any) => `- ${d.question}: ${d.answer}`).join("\n");
        const desc = req.description ? `Job description: ${req.description}` : "";
        const cat = req.category?.name ?? row.service_category ?? "";
        parts.push(`Thumbtack lead (${row.company ?? ""}, received ${row.lead_created ?? ""}):\n${cat ? `Category: ${cat}\n` : ""}${desc ? desc + "\n" : ""}${qa}`);
      }
    }
  } catch { /* best effort */ }

  return parts.join("\n\n");
}

async function buildOffer(db: any, conv: any): Promise<string> {
  try {
    const { data: offers } = await db.from("ai_campaign_offers").select("*").eq("brand", conv.brand).eq("active", true);
    if (!offers?.length) return "";
    const o = offers.find((o: any) => o.match_campaign && conv.campaign && String(o.match_campaign) === String(conv.campaign))
      ?? offers.find((o: any) => o.match_source && conv.lead_source && String(o.match_source) === String(conv.lead_source));
    if (!o) return "";
    return `${o.offer_name}: ${o.offer_text}${o.initial_charge_override != null ? ` (Use initial_charge = $${o.initial_charge_override} when closing.)` : ""}`;
  } catch { return ""; }
}

async function ensureFrLead(db: any, conv: any) {
  if (conv.brand !== "pestkee" || conv.fr_customer_id) return conv;
  if (!conv.contact_phone && !conv.contact_email) return conv;
  try {
    const cfg = await getServiceConfig(db, "pest_control");
    const id = await frUpsertLead(cfg, {
      name: conv.contact_name ?? "Unknown Lead",
      phone: conv.contact_phone ?? undefined,
      email: conv.contact_email ?? undefined,
    }, `New GHL lead (source: ${conv.lead_source ?? "unknown"}${conv.campaign ? ", campaign: " + conv.campaign : ""}). Working via AI setter / sales team.`);
    const { data } = await db.from("ai_conversations").update({ fr_customer_id: id, updated_at: new Date().toISOString() }).eq("id", conv.id).select().single();
    return data ?? conv;
  } catch (e) {
    console.error("ensureFrLead failed:", e);
    return conv;
  }
}

async function frNoteForConv(db: any, conv: any, text: string) {
  if (conv.brand !== "pestkee" || !conv.fr_customer_id) return;
  try {
    const cfg = await getServiceConfig(db, "pest_control");
    await frCreateNote(cfg, conv.fr_customer_id, text);
  } catch (e) { console.error("frNoteForConv:", e); }
}

async function enroll(db: any, convId: string, sequence: string, whenMs = Date.now(), step = 0) {
  const { data: existing } = await db.from("nurture_enrollments").select("id")
    .eq("conversation_id", convId).eq("sequence", sequence).eq("status", "active").maybeSingle();
  if (existing) return existing.id;
  const { data, error } = await db.from("nurture_enrollments")
    .insert({ conversation_id: convId, sequence, step, next_action_at: new Date(whenMs).toISOString() })
    .select().single();
  if (error) throw new Error(`enroll: ${error.message}`);
  return data.id;
}

async function completeEnrollments(db: any, convId: string, status = "completed") {
  await db.from("nurture_enrollments").update({ status, updated_at: new Date().toISOString() })
    .eq("conversation_id", convId).eq("status", "active");
}

async function armReengage(db: any, convId: string, st: any) {
  const next = new Date(Date.now() + (st.reengage_minutes ?? 120) * 60_000).toISOString();
  const { data: en } = await db.from("nurture_enrollments").select("id")
    .eq("conversation_id", convId).eq("sequence", "no_response").eq("status", "active").maybeSingle();
  if (en) await db.from("nurture_enrollments").update({ next_action_at: next, updated_at: new Date().toISOString() }).eq("id", en.id);
  else await db.from("nurture_enrollments").insert({ conversation_id: convId, sequence: "no_response", step: 0, next_action_at: next });
}

async function converse(db: any, st: any, conv: any, opts: { instruction?: string } = {}, depth = 0): Promise<any> {
  const brandRow = (await db.from("ai_brand_profiles").select("*").eq("brand", conv.brand).maybeSingle()).data
    ?? { brand: "advosy", display_name: "Advosy", persona_name: "Alex", tone: "friendly, brief", faq: "", service_types: [], booking_enabled: false };
  const [history, leadInfo, offerText] = await Promise.all([
    buildHistory(db, conv, st.timezone),
    buildLeadInfo(db, conv),
    buildOffer(db, conv),
  ]);
  const result = await runAgent({ db, settings: st, conv, brand: brandRow, history, leadInfo, offerText, instruction: opts.instruction });

  if (result.routedBrand && KNOWN_BRANDS.includes(result.routedBrand) && result.routedBrand !== conv.brand && depth < 1) {
    await db.from("ai_conversations").update({ brand: result.routedBrand, updated_at: new Date().toISOString() }).eq("id", conv.id);
    conv.brand = result.routedBrand;
    if (conv.brand === "pestkee") conv = await ensureFrLead(db, conv);
    return await converse(db, st, conv, opts, depth + 1);
  }

  if (result.contextPatch && Object.keys(result.contextPatch).length) {
    await db.from("ai_conversations").update({
      context: { ...(conv.context ?? {}), ...result.contextPatch }, updated_at: new Date().toISOString(),
    }).eq("id", conv.id);
  }
  if (result.flagged) {
    await db.from("ai_conversations").update({ status: "human", owner: "team", flagged_reason: result.flagged, updated_at: new Date().toISOString() }).eq("id", conv.id);
    await completeEnrollments(db, conv.id, "cancelled");
    try { await addTags(conv.ghl_contact_id, ["needs-human"]); } catch { /* best effort */ }
    await frNoteForConv(db, conv, `AI setter escalated to team: ${result.flagged}`);
  }
  if (result.closedReason) {
    await db.from("ai_conversations").update({ status: "closed", owner: "team", flagged_reason: null, updated_at: new Date().toISOString() }).eq("id", conv.id);
    await completeEnrollments(db, conv.id, "cancelled");
    try { await addTags(conv.ghl_contact_id, ["ai-closed-lost"]); } catch { /* best effort */ }
    await frNoteForConv(db, conv, `Lead did not move forward: ${result.closedReason}`);
  }
  if (result.booked) {
    await db.from("ai_conversations").update({ status: "booked", updated_at: new Date().toISOString() }).eq("id", conv.id);
    await completeEnrollments(db, conv.id);
    try { await addTags(conv.ghl_contact_id, ["ai-booked"]); } catch { /* best effort */ }
  }
  if (result.sold) {
    await db.from("ai_conversations").update({ status: "sold", updated_at: new Date().toISOString() }).eq("id", conv.id);
    await completeEnrollments(db, conv.id);
    try { await addTags(conv.ghl_contact_id, conv.brand === "pestkee" ? ["ai-sold", "pestkee-pending"] : ["ai-sold"]); } catch { /* best effort */ }
    try { await removeTags(conv.ghl_contact_id, ["pestkee-lead"]); } catch { /* best effort */ }
  }
  if (result.reply) {
    const sent = await sendMessage(conv, result.reply, brandRow);
    await logMsg(db, conv.id, "outbound", conv.channel, result.reply, true, { ghl: sent ?? null, flagged: result.flagged ?? null });
    const today = new Date().toISOString().slice(0, 10);
    await db.from("ai_conversations").update({
      last_outbound_at: new Date().toISOString(),
      msgs_sent_on: today,
      msgs_sent_count: (conv.msgs_sent_on === today ? (conv.msgs_sent_count ?? 0) : 0) + 1,
      updated_at: new Date().toISOString(),
    }).eq("id", conv.id);
  }
  return result;
}

async function aiRespondLive(db: any, st: any, conv: any) {
  await completeEnrollments(db, conv.id);
  const r = await converse(db, st, conv);
  if (r.reply && !r.booked && !r.sold && !r.flagged && !r.closedReason) {
    await db.from("ai_conversations").update({ owner: "ai", updated_at: new Date().toISOString() }).eq("id", conv.id);
    try { await addTags(conv.ghl_contact_id, conv.brand === "pestkee" ? ["ai-active", "pestkee-lead"] : ["ai-active"]); } catch { /* best effort */ }
    await armReengage(db, conv.id, st);
  }
  return r;
}

// ---------------- FieldRoutes -> GHL lifecycle sync ----------------
// Rate-limit safe: max 40 customer reads + 110s per run; hourly cron
// drains any backlog gradually (initial backfill included).
async function handleFrSync(db: any) {
  const t0 = Date.now();
  const cfg = await getServiceConfig(db, "pest_control");
  const subs = await frListSubscriptions(cfg);
  const rank: Record<string, number> = { active: 3, paused: 2, inactive: 1 };
  const byCust: Record<string, string> = {};
  for (const s of subs) {
    if (!byCust[s.customerID] || rank[s.status] > rank[byCust[s.customerID]]) byCust[s.customerID] = s.status;
  }
  const { data: prevRows } = await db.from("fr_customer_sync").select("fr_customer_id, sub_status");
  const prev = new Map((prevRows ?? []).map((r: any) => [r.fr_customer_id, r.sub_status]));
  const TAGS: Record<string, string> = { active: "pestkee-active", paused: "pestkee-paused", inactive: "pestkee-inactive" };

  let changed = 0, tagged = 0, errors = 0, processed = 0;
  for (const [custId, status] of Object.entries(byCust)) {
    if (prev.get(custId) === status) continue;
    if (processed >= 40 || Date.now() - t0 > 110_000) break; // FR rate-limit + wall-clock budget
    processed++; changed++;
    try {
      const c = await frGetCustomer(cfg, custId);
      if (!c.phone && !c.email) {
        await db.from("fr_customer_sync").upsert({ fr_customer_id: custId, sub_status: status, customer_name: c.name || null, synced_at: new Date().toISOString() });
        continue;
      }
      const up = await ghlUpsertContact({ phone: c.phone || undefined, email: c.email || undefined, name: c.name || undefined });
      const tag = TAGS[status];
      await addTags(up.contactId, [tag]);
      const remove = Object.values(TAGS).filter((t) => t !== tag);
      remove.push("pestkee-lead");
      if (status === "active") remove.push("pestkee-pending");
      try { await removeTags(up.contactId, remove); } catch { /* best effort */ }
      await db.from("fr_customer_sync").upsert({ fr_customer_id: custId, sub_status: status, ghl_contact_id: up.contactId, customer_name: c.name || null, synced_at: new Date().toISOString() });
      tagged++;
    } catch (e) {
      errors++;
      console.error("fr-sync error for customer", custId, e);
    }
  }
  return json({ ok: true, fr_customers: Object.keys(byCust).length, changed, tagged, errors, elapsed_ms: Date.now() - t0 });
}

// ---------------- inbound ----------------
async function handleInbound(db: any, st: any, p: any) {
  if (!p.contact_id) return json({ error: "contact_id required" }, 400);
  let conv = await upsertConversation(db, p);
  conv = await syncTakeoverState(db, conv);
  const event = p.event || "message";

  if (event === "reactivate") {
    if (conv.status === "customer") return json({ ok: true, skipped: "active/paused customer, CS team owns this" });
    try { await removeTags(conv.ghl_contact_id, ["needs-human", "ai-off", "ai-closed-lost"]); } catch { /* best effort */ }
    const patch: Record<string, unknown> = { status: "active", owner: "ai", flagged_reason: null, updated_at: new Date().toISOString() };
    if (p.brand && KNOWN_BRANDS.includes(String(p.brand))) patch.brand = p.brand;
    const { data: updated } = await db.from("ai_conversations").update(patch).eq("id", conv.id).select().single();
    conv = updated ?? conv;
    conv = await ensureFrLead(db, conv);
    try { await addTags(conv.ghl_contact_id, ["ai-active"]); } catch { /* best effort */ }
    const r = await converse(db, st, conv, {
      instruction: "This conversation was previously escalated to the human team, but you now have full capability to handle it (correct company selected). Read the history, pick up naturally where things left off, apologize lightly for the delay if they were left waiting, and move them forward to booking or closing per the brand knowledge. Do not mention the escalation or any internal mixup.",
    });
    if (r.reply) await armReengage(db, conv.id, st);
    return json({ ok: true, event, replied: !!r.reply, booked: !!r.booked, sold: !!r.sold });
  }

  if (event === "new_lead") {
    if (st.mode === "off") return json({ ok: true, skipped: "ai off" });
    if (conv.status === "customer") return json({ ok: true, skipped: "active/paused customer" });
    if (conv.status !== "active") return json({ ok: true, skipped: `status=${conv.status}` });
    try { await addTags(conv.ghl_contact_id, ["ai-active", ...(conv.brand === "pestkee" ? ["pestkee-lead"] : [])]); } catch { /* best effort */ }
    await db.from("ai_conversations").update({ owner: "ai", updated_at: new Date().toISOString() }).eq("id", conv.id);
    conv = await ensureFrLead(db, conv);
    if (p.first_touch === false) {
      const delayMin = Number(p.delay_min ?? 45);
      await enroll(db, conv.id, "speed_to_lead", Date.now() + delayMin * 60_000, 1);
      return json({ ok: true, event, enrolled: "speed_to_lead", first_touch: "external" });
    }
    if (!sendAllowedNow(st)) {
      await enroll(db, conv.id, "speed_to_lead", nextAllowedTime(st).getTime(), 0);
      return json({ ok: true, event, enrolled: "speed_to_lead", deferred: "quiet hours" });
    }
    await enroll(db, conv.id, "speed_to_lead");
    const { data: seq } = await db.from("nurture_sequences").select("steps").eq("sequence", "speed_to_lead").single();
    const goal = seq?.steps?.[0]?.goal ?? "Introduce yourself and start the conversation.";
    const r = await converse(db, st, conv, {
      instruction: `NEW LEAD EVENT (source: ${conv.lead_source ?? "unknown"}). ${goal} CHECK THE HISTORY AND LEAD DETAILS FIRST: if this contact is actually old or was already messaged, do NOT say they "just" reached out; continue naturally from where things left off instead. Compose the right outreach message now.`,
    });
    await db.from("nurture_enrollments").update({ step: 1, next_action_at: nextStepTime(seq?.steps, 1), updated_at: new Date().toISOString() })
      .eq("conversation_id", conv.id).eq("sequence", "speed_to_lead").eq("status", "active");
    return json({ ok: true, event, replied: !!r.reply });
  }

  if (event === "no_show") {
    if (conv.status === "opted_out" || conv.status === "customer") return json({ ok: true, skipped: conv.status });
    if (conv.status === "booked") await db.from("ai_conversations").update({ status: "active" }).eq("id", conv.id);
    await completeEnrollments(db, conv.id, "cancelled");
    await enroll(db, conv.id, "no_show", Date.now() + 15 * 60_000);
    return json({ ok: true, event, enrolled: "no_show" });
  }

  if (event === "enroll") {
    const sequence = p.sequence || "aged_reactivation";
    if (conv.status === "customer") return json({ ok: true, skipped: "active/paused customer" });
    if (conv.status !== "active") return json({ ok: true, skipped: `status=${conv.status}` });
    await enroll(db, conv.id, sequence);
    return json({ ok: true, event, enrolled: sequence });
  }

  // event === 'message' (customer replied)
  const body = String(p.message ?? "").trim();
  if (!body) return json({ ok: true, skipped: "empty message" });

  const { data: dupe } = await db.from("ai_messages").select("id")
    .eq("conversation_id", conv.id).eq("direction", "inbound").eq("body", body)
    .gte("created_at", new Date(Date.now() - 120_000).toISOString()).maybeSingle();
  if (dupe) return json({ ok: true, skipped: "duplicate" });

  await logMsg(db, conv.id, "inbound", p.channel === "email" ? "email" : "sms", body);
  await db.from("ai_conversations").update({ last_inbound_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", conv.id);

  if (OPT_OUT_RE.test(body)) {
    await db.from("ai_conversations").update({ status: "opted_out", owner: "team", updated_at: new Date().toISOString() }).eq("id", conv.id);
    await completeEnrollments(db, conv.id, "cancelled");
    try { await addTags(conv.ghl_contact_id, ["ai-opt-out"]); } catch { /* best effort */ }
    await frNoteForConv(db, conv, "Lead opted out of text/email outreach (STOP).");
    return json({ ok: true, opted_out: true });
  }

  if (conv.status === "customer") return json({ ok: true, skipped: "active/paused customer, CS team owns this" });
  if (st.mode === "off" || conv.status !== "active") return json({ ok: true, skipped: `status=${conv.status}, mode=${st.mode}` });

  if (conv.brand === "pestkee" && !conv.fr_customer_id) conv = await ensureFrLead(db, conv);

  await completeEnrollments(db, conv.id);

  if (!sendAllowedNow(st)) {
    const due = nextAllowedTime(st).toISOString();
    await db.from("ai_pending_replies").insert({ conversation_id: conv.id, inbound_at: new Date().toISOString(), due_at: due });
    return json({ ok: true, event, queued: true, quiet_hours: true, due_at: due });
  }

  if (conv.owner === "ai" || oooActive(st)) {
    const r = await aiRespondLive(db, st, conv);
    return json({ ok: true, event, replied: !!r.reply, mode: conv.owner === "ai" ? "ai-owner" : "ooo-takeover", flagged: r.flagged ?? null, booked: !!r.booked, sold: !!r.sold });
  }

  const due = new Date(Date.now() + (st.sla_minutes ?? 5) * 60_000).toISOString();
  await db.from("ai_pending_replies").insert({ conversation_id: conv.id, inbound_at: new Date().toISOString(), due_at: due });
  return json({ ok: true, event, queued: true, sla_minutes: st.sla_minutes ?? 5 });
}

function nextStepTime(steps: any[] | undefined, stepIdx: number): string {
  const arr = Array.isArray(steps) ? steps : [];
  if (stepIdx >= arr.length) return new Date().toISOString();
  const prev = Number(arr[stepIdx - 1]?.offset_min ?? 0);
  const cur = Number(arr[stepIdx]?.offset_min ?? 0);
  return new Date(Date.now() + Math.max(cur - prev, 1) * 60_000).toISOString();
}

// ---------------- tick (cron, every minute) ----------------
async function handleTick(db: any, st: any) {
  if (st.mode === "off") return json({ ok: true, skipped: "ai off" });
  const results: any[] = [];

  const { data: pending } = await db.from("ai_pending_replies")
    .select("*").lte("due_at", new Date().toISOString()).order("due_at").limit(20);
  for (const pr of (pending ?? [])) {
    try {
      await db.from("ai_pending_replies").delete().eq("id", pr.id);
      if (!sendAllowedNow(st)) {
        await db.from("ai_pending_replies").insert({ conversation_id: pr.conversation_id, inbound_at: pr.inbound_at, due_at: nextAllowedTime(st).toISOString() });
        results.push({ sla: pr.id, deferred: "quiet hours" });
        continue;
      }
      let { data: conv } = await db.from("ai_conversations").select("*").eq("id", pr.conversation_id).single();
      if (!conv || conv.status !== "active") { results.push({ sla: pr.id, skipped: "not active" }); continue; }
      conv = await syncTakeoverState(db, conv);
      if (conv.status !== "active") { results.push({ sla: pr.id, skipped: conv.status }); continue; }
      const { data: newer } = await db.from("ai_pending_replies").select("id").eq("conversation_id", conv.id).limit(1);
      if (newer && newer.length) { results.push({ sla: pr.id, skipped: "superseded" }); continue; }

      if (!oooActive(st) && await humanRepliedSince(db, conv, pr.inbound_at)) {
        await db.from("ai_conversations").update({ owner: "team", updated_at: new Date().toISOString() }).eq("id", conv.id);
        results.push({ sla: pr.id, standdown: "rep replied" });
        continue;
      }
      const r = await aiRespondLive(db, st, conv);
      results.push({ sla: pr.id, tookOver: true, replied: !!r.reply, flagged: r.flagged ?? null, booked: !!r.booked, sold: !!r.sold });
    } catch (e) {
      results.push({ sla: pr.id, error: String((e as Error)?.message ?? e) });
    }
  }

  const { data: due } = await db.from("nurture_enrollments")
    .select("*").eq("status", "active").lte("next_action_at", new Date().toISOString())
    .order("next_action_at").limit(15);

  for (const en of (due ?? [])) {
    try {
      let { data: conv } = await db.from("ai_conversations").select("*").eq("id", en.conversation_id).single();
      if (!conv || conv.status !== "active") {
        await db.from("nurture_enrollments").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", en.id);
        results.push({ id: en.id, skipped: "conversation not active" });
        continue;
      }
      conv = await syncTakeoverState(db, conv);
      if (conv.status !== "active") { results.push({ id: en.id, skipped: conv.status }); continue; }
      if (conv.owner !== "ai" && !oooActive(st)) {
        await db.from("nurture_enrollments").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", en.id);
        results.push({ id: en.id, skipped: "team-owned" });
        continue;
      }

      if (!sendAllowedNow(st)) {
        await db.from("nurture_enrollments").update({ next_action_at: nextAllowedTime(st).toISOString(), updated_at: new Date().toISOString() }).eq("id", en.id);
        results.push({ id: en.id, deferred: "quiet hours" });
        continue;
      }
      const today = new Date().toISOString().slice(0, 10);
      if (conv.msgs_sent_on === today && (conv.msgs_sent_count ?? 0) >= st.max_msgs_per_day) {
        await db.from("nurture_enrollments").update({ next_action_at: new Date(Date.now() + 20 * 3600_000).toISOString(), updated_at: new Date().toISOString() }).eq("id", en.id);
        results.push({ id: en.id, deferred: "daily cap" });
        continue;
      }

      const { data: seqRow } = await db.from("nurture_sequences").select("steps, active").eq("sequence", en.sequence).single();
      const steps = seqRow?.steps ?? [];
      if (!seqRow?.active || en.step >= steps.length) {
        await db.from("nurture_enrollments").update({ status: "completed", updated_at: new Date().toISOString() }).eq("id", en.id);
        results.push({ id: en.id, completed: true });
        continue;
      }

      const goal = steps[en.step]?.goal ?? "Follow up briefly and helpfully.";
      const r = await converse(db, st, conv, {
        instruction: `SCHEDULED FOLLOW-UP (sequence: ${en.sequence}, touch ${en.step + 1} of ${steps.length}; the lead has NOT replied since your last message). Goal: ${goal} Read the full history first and continue naturally; NEVER repeat an intro or act like the lead just reached out. If genuinely nothing useful can be said, use do_not_reply.`,
      });

      const nextStep = en.step + 1;
      if (nextStep >= steps.length || r.booked || r.sold || r.flagged || r.closedReason) {
        await db.from("nurture_enrollments").update({ status: "completed", step: nextStep, updated_at: new Date().toISOString() }).eq("id", en.id);
        if (nextStep >= steps.length && !r.booked && !r.sold && !r.flagged && !r.closedReason) {
          await frNoteForConv(db, conv, `AI nurture sequence (${en.sequence}) completed with no response from lead.`);
        }
      } else {
        await db.from("nurture_enrollments").update({ step: nextStep, next_action_at: nextStepTime(steps, nextStep), updated_at: new Date().toISOString() }).eq("id", en.id);
      }
      results.push({ id: en.id, step: en.step, sent: !!r.reply });
    } catch (e) {
      results.push({ id: en.id, error: String((e as Error)?.message ?? e) });
      await db.from("nurture_enrollments").update({ next_action_at: new Date(Date.now() + 2 * 3600_000).toISOString(), updated_at: new Date().toISOString() }).eq("id", en.id);
    }
  }
  return json({ ok: true, processed: results.length, results });
}

// ---------------- daily digest ----------------
async function handleDigest(db: any, st: any) {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const day = new Intl.DateTimeFormat("en-US", { timeZone: st.timezone, weekday: "long", month: "long", day: "numeric" }).format(new Date());

  const [convsR, inR, outR, escR, soldConvR, sessR, optR] = await Promise.all([
    db.from("ai_conversations").select("id", { count: "exact", head: true }).gte("created_at", since),
    db.from("ai_messages").select("id", { count: "exact", head: true }).eq("direction", "inbound").gte("created_at", since),
    db.from("ai_messages").select("id", { count: "exact", head: true }).eq("direction", "outbound").eq("ai_generated", true).gte("created_at", since),
    db.from("ai_conversations").select("contact_name, contact_phone, flagged_reason, brand").eq("status", "human").not("flagged_reason", "is", null).gte("updated_at", since),
    db.from("ai_conversations").select("contact_name, contact_phone, brand").eq("status", "sold").gte("updated_at", since),
    db.from("booking_sessions").select("id, created_at, booking_items(service_type, appointment_type, provider_ref, slot_start, status, contract_value)").eq("source", "AI Setter").gte("created_at", since),
    db.from("ai_conversations").select("id", { count: "exact", head: true }).eq("status", "opted_out").gte("updated_at", since),
  ]);

  const esc = escR.data ?? [];
  const soldConvs = soldConvR.data ?? [];
  const items = (sessR.data ?? []).flatMap((s: any) => s.booking_items ?? []);
  const bookedItems = items.filter((i: any) => i.appointment_type !== "sold_customer");
  const soldItems = items.filter((i: any) => i.appointment_type === "sold_customer");

  const escRows = esc.map((e: any) => `<li><b>${e.contact_name ?? "Unknown"}</b> (${e.brand ?? ""}, ${e.contact_phone ?? "no phone"}): ${e.flagged_reason}</li>`).join("");
  const soldRows = soldConvs.map((e: any) => `<li><b>${e.contact_name ?? "Unknown"}</b> (${e.brand ?? ""}, ${e.contact_phone ?? "no phone"})</li>`).join("");
  const bookRows = bookedItems.map((b: any) => `<li>${b.service_type} at ${b.slot_start ? new Intl.DateTimeFormat("en-US", { timeZone: st.timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(b.slot_start)) : "?"} (ref ${b.provider_ref ?? "?"}, ${b.status})</li>`).join("");

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:auto;color:#1a2230">
  <h2 style="color:#8b5cf6;margin:0 0 2px">AI Setter, Daily Digest</h2>
  <div style="color:#888;font-size:13px;margin-bottom:16px">${day} (last 24 hours)</div>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <tr><td style="padding:6px 10px;border-bottom:1px solid #eee">New conversations</td><td align="right" style="padding:6px 10px;border-bottom:1px solid #eee"><b>${convsR.count ?? 0}</b></td></tr>
    <tr><td style="padding:6px 10px;border-bottom:1px solid #eee">Customer messages in</td><td align="right" style="padding:6px 10px;border-bottom:1px solid #eee"><b>${inR.count ?? 0}</b></td></tr>
    <tr><td style="padding:6px 10px;border-bottom:1px solid #eee">AI replies sent</td><td align="right" style="padding:6px 10px;border-bottom:1px solid #eee"><b>${outR.count ?? 0}</b></td></tr>
    <tr><td style="padding:6px 10px;border-bottom:1px solid #eee">Appointments booked</td><td align="right" style="padding:6px 10px;border-bottom:1px solid #eee"><b>${bookedItems.length}</b></td></tr>
    <tr><td style="padding:6px 10px;border-bottom:1px solid #eee">Accounts SOLD</td><td align="right" style="padding:6px 10px;border-bottom:1px solid #eee;color:#16834a"><b>${Math.max(soldItems.length, soldConvs.length)}</b></td></tr>
    <tr><td style="padding:6px 10px;border-bottom:1px solid #eee">Escalated to team</td><td align="right" style="padding:6px 10px;border-bottom:1px solid #eee"><b>${esc.length}</b></td></tr>
    <tr><td style="padding:6px 10px;border-bottom:1px solid #eee">Opt-outs</td><td align="right" style="padding:6px 10px;border-bottom:1px solid #eee"><b>${optR.count ?? 0}</b></td></tr>
  </table>
  ${soldRows ? `<h3 style="margin:18px 0 6px;color:#16834a">Sold</h3><ul style="font-size:14px">${soldRows}</ul>` : ""}
  ${bookRows ? `<h3 style="margin:18px 0 6px">Booked</h3><ul style="font-size:14px">${bookRows}</ul>` : ""}
  ${escRows ? `<h3 style="margin:18px 0 6px;color:#b45309">Needs human follow-up</h3><ul style="font-size:14px">${escRows}</ul>` : ""}
  <p style="color:#999;font-size:12px;margin-top:18px">Transcripts: ai_messages table in the advosy-booking Supabase project.</p></div>`;

  const to = (await getSecret("AI_DIGEST_TO")) || (await getSecret("MAIL_TO")) || "chandler@advosy.com";
  const sent = await sendInternalEmail([to], `AI Setter Daily Digest, ${day}`, html);
  return json({ ok: true, sent, to });
}

// ---------------- server ----------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const db = admin();
    let body: any = {};
    try { body = await req.json(); } catch { /* empty body ok */ }

    const expected = await getSecret("AI_WEBHOOK_TOKEN");
    const provided = req.headers.get("x-ai-token") || body.token || "";
    if (!expected || provided !== expected) return json({ error: "unauthorized" }, 401);

    const path = new URL(req.url).pathname;
    const st = await getSettings(db);
    if (path.endsWith("/tick")) return await handleTick(db, st);
    if (path.endsWith("/digest")) return await handleDigest(db, st);
    if (path.endsWith("/fr-sync")) return await handleFrSync(db); // runs regardless of AI mode
    return await handleInbound(db, st, body);
  } catch (e) {
    console.error("ai-setter error:", e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
