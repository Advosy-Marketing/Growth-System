// =====================================================================
// POST /functions/v1/abstrakt-intake
// Receives an Abstrakt Marketing appointment-notification email (forwarded
// by a Google Apps Script trigger on the work inbox), parses it, creates
// the appointment in the Everest GoHighLevel sub-account assigned to the
// fixed sales rep, and SMS-notifies the rep + sales managers.
//
// Reuses the same GHL v2 patterns as the booking app (_shared/ghl.ts) and
// the ai-setter SMS helper (comms.ts sendSmsToPhone), kept self-contained
// here so the function deploys independently.
//
// Intake modes (any one works):
//   • GHL-native: a GHL workflow (trigger: inbound email from the Abstrakt
//     carrier contact) POSTs { emailMessageId, locationId } + secret. The
//     function pulls the full email body back from the GHL API so nothing is
//     truncated and the voice-recording link survives.
//   • Gmail script: Apps Script POSTs { messageId, from, subject, text, html }.
//   • Dry run: add ?dryRun=1 (or body.dryRun=true) to parse ONLY and return
//     the extracted fields + the messages it *would* send. No GHL calls,
//     no secrets required beyond ANTHROPIC_API_KEY. Use this to validate the
//     parser against a real sample email before wiring the Everest secrets.
//
// Config (env vars or Vault secrets via public.get_secret):
//   ABSTRAKT_WEBHOOK_SECRET   shared secret; Apps Script sends it as
//                             header  x-abstrakt-secret
//   ANTHROPIC_API_KEY         for email parsing (Claude)
//   GHL_TOKEN_EVEREST         Everest GHL API token (falls back to GHL_TOKEN)
//   EVEREST_GHL_LOCATION_ID   Everest sub-account / location id
//   EVEREST_GHL_CALENDAR_ID   calendar appointments land on
//   EVEREST_GHL_REP_USER_ID   fixed rep's GHL user id (assignedUserId)
//   ABSTRAKT_REP_PHONE        rep cell (SMS)
//   ABSTRAKT_MANAGER_PHONES   comma-separated manager cells (SMS)
//   ABSTRAKT_TZ               default "America/Phoenix"
//   ABSTRAKT_APPT_DURATION_MIN default 30
//   ABSTRAKT_EXPECTED_SENDER  optional; if set, rejects emails not from it
// =====================================================================

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const GHL_BASE = "https://services.leadconnectorhq.com";
const CAL_VERSION = "2021-04-15";
const MSG_VERSION = "2021-04-15";
const CONTACT_VERSION = "2021-07-28";
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const PARSE_MODEL = "claude-sonnet-5";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-abstrakt-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function admin(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

// env first, then Vault (public.get_secret) — same resolution order the rest
// of the stack uses.
async function cfg(name: string): Promise<string | undefined> {
  const env = Deno.env.get(name);
  if (env) return env;
  try {
    const { data, error } = await admin().rpc("get_secret", { p_name: name });
    if (!error && data) return data as string;
  } catch (_) { /* ignore */ }
  return undefined;
}
async function cfgRequired(name: string): Promise<string> {
  const v = await cfg(name);
  if (!v) throw new Error(`Missing config ${name} (set env var or Vault secret)`);
  return v;
}

// ---------- GHL ----------
async function ghlToken(): Promise<string> {
  return (await cfg("GHL_TOKEN_EVEREST")) || (await cfgRequired("GHL_TOKEN"));
}
async function ghl(path: string, version: string, init: RequestInit = {}) {
  const token = await ghlToken();
  const res = await fetch(`${GHL_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Version: version,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) throw new Error(`GHL ${init.method ?? "GET"} ${path} → ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

const isValidEmail = (e?: string): boolean => !!e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

function normalizePhone(p?: string): string | undefined {
  if (!p) return undefined;
  const d = p.replace(/[^\d+]/g, "");
  if (d.startsWith("+")) return d;
  const digits = d.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits ? `+${digits}` : undefined;
}

async function getCalendarDuration(calendarId: string, fallbackMin: number): Promise<number> {
  try {
    const data = await ghl(`/calendars/${calendarId}`, CAL_VERSION);
    const cal = data?.calendar ?? {};
    if (typeof cal.slotDuration === "number" && cal.slotDuration > 0) {
      const unit = String(cal.slotDurationUnit ?? "mins").toLowerCase();
      return unit.startsWith("hour") ? cal.slotDuration * 60 : cal.slotDuration;
    }
  } catch (_) { /* fall back */ }
  return fallbackMin;
}

interface ParsedLead {
  leadName?: string;
  businessName?: string;
  contactPhone?: string;
  contactEmail?: string;
  contactMethod?: string;
  address?: string;
  appointmentStartISO?: string | null;  // ISO 8601 with offset, or null if unknown
  appointmentRaw?: string;               // the raw date/time text as written
  notes?: string;
  voiceRecordingUrl?: string;
}

async function parseEmail(subject: string, sender: string, text: string, tz: string): Promise<ParsedLead> {
  const apiKey = await cfgRequired("ANTHROPIC_API_KEY");
  const sys = `You extract structured appointment data from B2B appointment-setting notification emails sent by an agency (Abstrakt Marketing) to a sales team. Return ONLY a single JSON object, no prose, matching this TypeScript type:
{
  "leadName": string | null,            // the prospect contact person
  "businessName": string | null,        // the prospect's company
  "contactPhone": string | null,
  "contactEmail": string | null,
  "contactMethod": string | null,       // e.g. "Phone call", "Zoom", "In person"
  "address": string | null,
  "appointmentStartISO": string | null, // the scheduled appointment date/time as ISO 8601 WITH timezone offset for ${tz}. Null if the email does not clearly state one.
  "appointmentRaw": string | null,      // the date/time exactly as written in the email
  "notes": string | null,               // appointment notes / conversation summary the rep should read
  "voiceRecordingUrl": string | null    // URL to the call recording, if present
}
Rules:
- Infer nothing you cannot see. Preserve the full notes/comments text verbatim in "notes".
- contactPhone: prefer the prospect's direct mobile/cell number when one is given; otherwise use the main phone.
- TIMEZONE (critical): these appointments are in Arizona (America/Phoenix), which stays at UTC-07:00 all year and does NOT observe daylight saving. The agency frequently MISLABELS the time as "PST" or "PDT" — ignore that label entirely. Interpret the stated appointment clock time as Arizona local wall-clock time and output appointmentStartISO with a -07:00 offset. Example: "10:00 AM PST" on 7/23/2026 → "2026-07-23T10:00:00-07:00". Only produce appointmentStartISO if the email states an actual meeting date and time; otherwise null.`;
  const user = `SUBJECT: ${subject}\nFROM: ${sender}\n\nEMAIL BODY:\n${text}`;

  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: PARSE_MODEL,
      max_tokens: 1500,
      system: sys,
      messages: [{ role: "user", content: user }],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Claude parse → ${res.status}: ${JSON.stringify(body)}`);
  const raw = (body?.content ?? []).map((c: any) => c?.text ?? "").join("").trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Claude returned no JSON: ${raw.slice(0, 300)}`);
  const p = JSON.parse(match[0]);
  // null → undefined for cleanliness
  const clean = (v: any) => (v === null || v === "" ? undefined : v);
  return {
    leadName: clean(p.leadName),
    businessName: clean(p.businessName),
    contactPhone: clean(p.contactPhone),
    contactEmail: clean(p.contactEmail),
    contactMethod: clean(p.contactMethod),
    address: clean(p.address),
    appointmentStartISO: p.appointmentStartISO ?? null,
    appointmentRaw: clean(p.appointmentRaw),
    notes: clean(p.notes),
    voiceRecordingUrl: clean(p.voiceRecordingUrl),
  };
}

// Strip HTML to plain-ish text when the email only carried an HTML part.
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ")
    .trim();
}

// Build the SMS body sent to rep + managers.
function buildSms(p: ParsedLead): string {
  const when = p.appointmentStartISO
    ? new Date(p.appointmentStartISO).toLocaleString("en-US", { timeZone: Deno.env.get("ABSTRAKT_TZ") || "America/Phoenix", dateStyle: "medium", timeStyle: "short" })
    : (p.appointmentRaw || "TIME TBD — confirm");
  const lines = [
    "New Abstrakt appointment (Everest)",
    p.businessName ? `Business: ${p.businessName}` : null,
    p.leadName ? `Contact: ${p.leadName}` : null,
    p.contactPhone ? `Phone: ${p.contactPhone}` : null,
    `When: ${when}`,
    p.contactMethod ? `Method: ${p.contactMethod}` : null,
    p.voiceRecordingUrl ? `Call recording: ${p.voiceRecordingUrl}` : null,
  ].filter(Boolean);
  return lines.join("\n");
}

async function sendSms(locationId: string, phone: string, message: string) {
  const norm = normalizePhone(phone);
  if (!norm) throw new Error(`invalid phone: ${phone}`);
  const up = await ghl(`/contacts/upsert`, CONTACT_VERSION, {
    method: "POST",
    body: JSON.stringify({ locationId, phone: norm }),
  });
  const contactId = up?.contact?.id ?? up?.id;
  if (!contactId) throw new Error(`could not upsert contact for ${norm}`);
  return await ghl(`/conversations/messages`, MSG_VERSION, {
    method: "POST",
    body: JSON.stringify({ type: "SMS", contactId, message }),
  });
}

// GHL-native mode: fetch the full inbound email from GHL by message id.
// Returns best-effort subject / from / text / html from the message record.
async function fetchGhlEmail(messageId: string): Promise<{ subject?: string; from?: string; text?: string; html?: string }> {
  const data = await ghl(`/conversations/messages/${messageId}`, MSG_VERSION);
  const m = data?.message ?? data?.messages?.[0] ?? data ?? {};
  // GHL email records vary; try the common shapes.
  const emailBody = m?.body ?? m?.emailBody ?? m?.meta?.email?.body;
  return {
    subject: m?.subject ?? m?.meta?.email?.subject,
    from: m?.from ?? m?.emailFrom ?? m?.meta?.email?.from,
    text: typeof emailBody === "string" && !/<[a-z]/i.test(emailBody) ? emailBody : undefined,
    html: typeof emailBody === "string" && /<[a-z]/i.test(emailBody) ? emailBody : (m?.html ?? undefined),
  };
}

async function auditLog(db: SupabaseClient, action: string, request: unknown, response: unknown, ok: boolean) {
  try {
    await db.from("audit_log").insert({ session_id: null, provider: "ghl", action, request: request ?? null, response: response ?? null, ok });
  } catch (_) { /* best effort */ }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const url = new URL(req.url);
  const db = admin();
  const tz = (await cfg("ABSTRAKT_TZ")) || "America/Phoenix";
  const durationMin = Number((await cfg("ABSTRAKT_APPT_DURATION_MIN")) || "30");

  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }

  const dryRun = url.searchParams.get("dryRun") === "1" || payload?.dryRun === true;

  // ---- Auth (skipped for dry run so the parser can be tested freely) ----
  if (!dryRun) {
    const expected = await cfgRequired("ABSTRAKT_WEBHOOK_SECRET");
    const got = req.headers.get("x-abstrakt-secret") ?? payload?.secret;
    if (got !== expected) return json({ error: "unauthorized" }, 401);
  }

  const ghlMessageId: string | undefined = payload?.emailMessageId || payload?.ghlMessageId || payload?.message?.id;
  const messageId: string = ghlMessageId || payload?.messageId || payload?.message_id || `manual-${Date.now()}`;
  let subject: string = payload?.subject ?? "";
  let sender: string = payload?.from ?? payload?.sender ?? "";
  const receivedAt: string = payload?.receivedAt ?? payload?.received_at ?? new Date().toISOString();
  let bodyText: string = (payload?.text && String(payload.text).trim())
    ? String(payload.text)
    : (payload?.html ? htmlToText(String(payload.html)) : "");

  // GHL-native mode: no inline body, but a GHL message id → pull it from GHL.
  if (!bodyText && ghlMessageId && !dryRun) {
    try {
      const m = await fetchGhlEmail(ghlMessageId);
      subject = subject || m.subject || "";
      sender = sender || m.from || "";
      bodyText = (m.text && m.text.trim()) ? m.text : (m.html ? htmlToText(m.html) : "");
    } catch (e) {
      return json({ ok: false, stage: "fetch_ghl_email", error: String((e as Error)?.message ?? e) }, 200);
    }
  }

  if (!bodyText) return json({ error: "email body required (inline text/html, or a resolvable GHL emailMessageId)" }, 400);

  // Optional sender allow-list.
  const expectedSender = await cfg("ABSTRAKT_EXPECTED_SENDER");
  if (expectedSender && sender && !sender.toLowerCase().includes(expectedSender.toLowerCase())) {
    return json({ ok: false, skipped: true, reason: `sender ${sender} not from ${expectedSender}` });
  }

  // ---- Parse ----
  let parsed: ParsedLead;
  try {
    parsed = await parseEmail(subject, sender, bodyText, tz);
  } catch (e) {
    return json({ ok: false, stage: "parse", error: String((e as Error)?.message ?? e) }, 200);
  }

  const smsBody = buildSms(parsed);

  if (dryRun) {
    return json({
      ok: true,
      dryRun: true,
      parsed,
      wouldSendSms: smsBody,
      note: "No GHL calls made. Wire the Everest secrets, then POST without dryRun to go live.",
    });
  }

  // ---- Idempotency: claim the message id ----
  const { data: existing } = await db.from("abstrakt_intake").select("id,status").eq("message_id", messageId).maybeSingle();
  if (existing?.status === "success") {
    return json({ ok: true, duplicate: true, message: "already processed", id: existing.id });
  }
  let rowId = existing?.id as string | undefined;
  if (!rowId) {
    const { data: ins, error: insErr } = await db.from("abstrakt_intake").insert({
      message_id: messageId, received_at: receivedAt, subject, sender, status: "processing", parsed,
    }).select("id").single();
    if (insErr) return json({ ok: false, stage: "claim", error: insErr.message }, 200);
    rowId = ins.id;
  } else {
    await db.from("abstrakt_intake").update({ status: "processing", parsed, updated_at: new Date().toISOString() }).eq("id", rowId);
  }

  try {
    const locationId = await cfgRequired("EVEREST_GHL_LOCATION_ID");
    const calendarId = await cfgRequired("EVEREST_GHL_CALENDAR_ID");
    const repUserId = await cfgRequired("EVEREST_GHL_REP_USER_ID");

    // 1) Upsert the prospect contact.
    const nameParts = (parsed.leadName || parsed.businessName || "Abstrakt Lead").trim().split(/\s+/);
    const firstName = nameParts.shift() || parsed.leadName || "Abstrakt";
    const lastName = nameParts.join(" ") || undefined;
    const contactBody: Record<string, unknown> = {
      locationId,
      firstName,
      lastName,
      name: parsed.leadName || parsed.businessName,
      companyName: parsed.businessName,
      source: "Abstrakt Marketing",
      tags: ["Abstrakt B2B", "Everest"],
    };
    if (isValidEmail(parsed.contactEmail)) contactBody.email = parsed.contactEmail!.trim();
    const cPhone = normalizePhone(parsed.contactPhone);
    if (cPhone) contactBody.phone = cPhone;
    if (parsed.address) contactBody.address1 = parsed.address;

    const cRes = await ghl(`/contacts/upsert`, CONTACT_VERSION, { method: "POST", body: JSON.stringify(contactBody) });
    const contactId = cRes?.contact?.id ?? cRes?.id;
    if (!contactId) throw new Error(`contact upsert returned no id: ${JSON.stringify(cRes)}`);

    // 2) Resolve appointment time. Fallback: next day 09:00 in tz, flagged.
    let startISO = parsed.appointmentStartISO;
    let timeFlagged = false;
    if (!startISO) {
      timeFlagged = true;
      const d = new Date();
      d.setDate(d.getDate() + 1);
      const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
      startISO = `${ymd}T09:00:00-07:00`; // Arizona (no DST); placeholder, flagged for confirmation
    }
    const dur = await getCalendarDuration(calendarId, durationMin);
    const startMs = Date.parse(startISO);
    const endISO = Number.isFinite(startMs) ? new Date(startMs + dur * 60000).toISOString() : undefined;

    const descLines = [
      "Source: Abstrakt Marketing (B2B appointment set)",
      parsed.businessName ? `Business: ${parsed.businessName}` : null,
      parsed.leadName ? `Contact: ${parsed.leadName}` : null,
      parsed.contactPhone ? `Phone: ${parsed.contactPhone}` : null,
      parsed.contactEmail ? `Email: ${parsed.contactEmail}` : null,
      parsed.contactMethod ? `Meeting method: ${parsed.contactMethod}` : null,
      parsed.appointmentRaw ? `Requested time: ${parsed.appointmentRaw}` : null,
      timeFlagged ? "⚠ TIME NOT PARSED — placeholder set, confirm with prospect" : null,
      parsed.voiceRecordingUrl ? `Call recording: ${parsed.voiceRecordingUrl}` : null,
      parsed.address ? `Address: ${parsed.address}` : null,
      parsed.notes ? `\nNotes:\n${parsed.notes}` : null,
    ].filter(Boolean).join("<br>");

    const apptBody: Record<string, unknown> = {
      calendarId,
      locationId,
      contactId,
      startTime: startISO,
      ...(endISO ? { endTime: endISO } : {}),
      title: `Abstrakt Appt — ${parsed.businessName || parsed.leadName || "Everest lead"}${timeFlagged ? " · ⚠ CONFIRM TIME" : ""}`,
      description: descLines,
      appointmentStatus: "confirmed",
      assignedUserId: repUserId,
      ignoreDateRange: true,
      ignoreFreeSlotValidation: true,
    };
    if (parsed.address) apptBody.address = parsed.address;

    const aRes = await ghl(`/calendars/events/appointments`, CAL_VERSION, { method: "POST", body: JSON.stringify(apptBody) });
    const apptId = aRes?.id ?? aRes?.appointment?.id;
    if (!apptId) throw new Error(`create appointment returned no id: ${JSON.stringify(aRes)}`);

    // 3) Contact note (full detail + recording link, best-effort).
    try {
      const noteBody = [
        "📅 Abstrakt Marketing appointment",
        parsed.businessName ? `Business: ${parsed.businessName}` : null,
        parsed.leadName ? `Contact: ${parsed.leadName}` : null,
        parsed.contactPhone ? `Phone: ${parsed.contactPhone}` : null,
        parsed.contactEmail ? `Email: ${parsed.contactEmail}` : null,
        parsed.contactMethod ? `Method: ${parsed.contactMethod}` : null,
        parsed.appointmentRaw ? `Time: ${parsed.appointmentRaw}` : null,
        parsed.voiceRecordingUrl ? `Recording: ${parsed.voiceRecordingUrl}` : null,
        parsed.notes ? `\nNotes:\n${parsed.notes}` : null,
      ].filter(Boolean).join("\n");
      await ghl(`/contacts/${contactId}/notes`, CONTACT_VERSION, { method: "POST", body: JSON.stringify({ body: noteBody }) });
    } catch (_) { /* note is best-effort */ }

    // 4) Notify rep + managers by SMS.
    const repPhone = await cfg("ABSTRAKT_REP_PHONE");
    const mgrPhones = ((await cfg("ABSTRAKT_MANAGER_PHONES")) || "").split(",").map((s) => s.trim()).filter(Boolean);
    const recipients = [repPhone, ...mgrPhones].filter(Boolean) as string[];
    const smsResults: Record<string, string> = {};
    for (const ph of recipients) {
      try { await sendSms(locationId, ph, smsBody); smsResults[ph] = "sent"; }
      catch (e) { smsResults[ph] = `failed: ${String((e as Error)?.message ?? e)}`; }
    }

    await db.from("abstrakt_intake").update({
      status: "success", ghl_contact_id: contactId, ghl_appointment_id: apptId,
      parsed, error: null, updated_at: new Date().toISOString(),
    }).eq("id", rowId);
    await auditLog(db, "abstrakt_intake", { messageId, subject }, { contactId, apptId, timeFlagged, smsResults }, true);

    return json({ ok: true, contactId, appointmentId: apptId, timeFlagged, smsResults });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    await db.from("abstrakt_intake").update({ status: "failed", error: msg, updated_at: new Date().toISOString() }).eq("id", rowId);
    await auditLog(db, "abstrakt_intake", { messageId, subject }, { error: msg }, false);
    // Safety: alert managers so a failed intake is never silently lost.
    try {
      const locationId = await cfg("EVEREST_GHL_LOCATION_ID");
      const mgrPhones = ((await cfg("ABSTRAKT_MANAGER_PHONES")) || "").split(",").map((s) => s.trim()).filter(Boolean);
      if (locationId && mgrPhones.length) {
        const alert = `⚠ Abstrakt intake FAILED — needs manual entry.\nSubject: ${subject}\n${parsed.businessName || parsed.leadName || ""}`.trim();
        for (const ph of mgrPhones) { try { await sendSms(locationId, ph, alert); } catch (_) { /* */ } }
      }
    } catch (_) { /* */ }
    return json({ ok: false, stage: "ghl", error: msg }, 200);
  }
});
