// Supabase Edge Function: opportunities
// Booking history + admin edit/cancel for opportunities (booking_session + items).
// verify_jwt = false; the actor's PIN + role are checked server-side via public.verify_pin (bcrypt + lockout).
// Endpoint: POST {SUPABASE_URL}/functions/v1/opportunities
// Body: { actor_id, pin, op, ...params }
//   op: list | update_session | update_item | cancel
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_CAL_VERSION = "2021-04-15";

async function ghlToken(serviceType: string): Promise<string | null> {
  const svc = serviceType.toUpperCase();
  const envPer = Deno.env.get(`GHL_TOKEN_${svc}`);
  if (envPer) return envPer;
  try {
    const { data, error } = await admin.rpc("get_secret", { p_name: `GHL_TOKEN_${svc}` });
    if (!error && data) return data as string;
  } catch { /* fall through to shared */ }
  const envShared = Deno.env.get("GHL_TOKEN");
  if (envShared) return envShared;
  try {
    const { data } = await admin.rpc("get_secret", { p_name: "GHL_TOKEN" });
    return (data as string) ?? null;
  } catch { return null; }
}
async function ghlCancel(serviceType: string, apptId: string): Promise<boolean> {
  try {
    const t = await ghlToken(serviceType);
    if (!t || !apptId) return false;
    const r = await fetch(`${GHL_BASE}/calendars/events/appointments/${apptId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${t}`, Version: GHL_CAL_VERSION, Accept: "application/json" },
    });
    return r.ok;
  } catch { return false; }
}
async function ghlReschedule(serviceType: string, apptId: string, startISO: string, endISO: string): Promise<boolean> {
  try {
    const t = await ghlToken(serviceType);
    if (!t || !apptId) return false;
    const r = await fetch(`${GHL_BASE}/calendars/events/appointments/${apptId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${t}`, Version: GHL_CAL_VERSION, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ startTime: startISO, endTime: endISO }),
    });
    return r.ok;
  } catch { return false; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const { actor_id, pin, op } = body ?? {};
  if (!actor_id || !pin || !op) return json({ error: "actor_id, pin, op required" }, 400);

  const { data: auth, error: vErr } = await admin.rpc("verify_pin", { p_user: actor_id, p_pin: String(pin) });
  if (vErr) return json({ error: vErr.message }, 500);
  if (!auth?.ok) return json({ error: auth?.error ?? "invalid pin" }, 401);
  const canManage = ["admin", "manager"].includes(auth.role);

  try {
    switch (op) {
      // ---------- LIST (any active user) ----------
      case "list": {
        const limit = Math.min(Number(body.limit ?? 300), 1000);
        let q = admin.from("booking_sessions")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(limit);
        if (body.date_from) q = q.gte("created_at", body.date_from);
        if (body.date_to) q = q.lte("created_at", body.date_to);
        const { data: sessions, error } = await q;
        if (error) throw error;
        const sIds = (sessions ?? []).map((s: any) => s.id);
        const cIds = [...new Set((sessions ?? []).map((s: any) => s.customer_id).filter(Boolean))];
        const rIds = [...new Set((sessions ?? []).map((s: any) => s.rep_id).filter(Boolean))];

        const [itemsRes, custRes, repRes] = await Promise.all([
          sIds.length ? admin.from("booking_items").select("*").in("session_id", sIds) : Promise.resolve({ data: [] }),
          cIds.length ? admin.from("customers").select("*").in("id", cIds) : Promise.resolve({ data: [] }),
          rIds.length ? admin.from("app_users").select("id, full_name, team").in("id", rIds) : Promise.resolve({ data: [] }),
        ]);
        const itemsBy: Record<string, any[]> = {};
        for (const it of ((itemsRes as any).data ?? [])) (itemsBy[it.session_id] ??= []).push(it);
        const custBy: Record<string, any> = {};
        for (const c of ((custRes as any).data ?? [])) custBy[c.id] = c;
        const repBy: Record<string, any> = {};
        for (const r of ((repRes as any).data ?? [])) repBy[r.id] = r;

        const opportunities = (sessions ?? []).map((s: any) => ({
          session_id: s.id,
          created_at: s.created_at,
          source: s.source,
          channel: s.channel,
          channel_other: s.channel_other,
          campaign: s.campaign,
          campaign_other: s.campaign_other,
          notes: s.notes,
          gate_code: s.gate_code,
          emergency: s.emergency,
          rep_id: s.rep_id,
          rep_name: repBy[s.rep_id]?.full_name ?? null,
          customer: custBy[s.customer_id] ?? null,
          items: (itemsBy[s.id] ?? []).sort((a, b) => (a.created_at || "").localeCompare(b.created_at || "")),
        }));
        return json({ ok: true, opportunities });
      }

      // ---------- UPDATE SESSION (admin/manager) ----------
      case "update_session": {
        if (!canManage) return json({ error: "not authorized" }, 403);
        if (!body.session_id) return json({ error: "session_id required" }, 400);
        const p = body.patch ?? {};
        const patch: any = {};
        for (const k of ["source", "channel", "channel_other", "campaign", "campaign_other", "notes", "gate_code", "emergency"]) {
          if (k in p) patch[k] = p[k];
        }
        if (p.customer && typeof p.customer === "object") {
          const { data: sess } = await admin.from("booking_sessions").select("customer_id").eq("id", body.session_id).maybeSingle();
          if (sess?.customer_id) {
            const cp: any = {};
            for (const k of ["name", "phone", "email", "address"]) if (k in p.customer) cp[k] = p.customer[k];
            if (Object.keys(cp).length) await admin.from("customers").update(cp).eq("id", sess.customer_id);
          }
        }
        patch.updated_at = new Date().toISOString();
        const { data, error } = await admin.from("booking_sessions").update(patch).eq("id", body.session_id).select().single();
        if (error) throw error;
        return json({ ok: true, session: data });
      }

      // ---------- UPDATE ITEM (admin/manager) ----------
      case "update_item": {
        if (!canManage) return json({ error: "not authorized" }, 403);
        if (!body.item_id) return json({ error: "item_id required" }, 400);
        const p = body.patch ?? {};
        const { data: cur } = await admin.from("booking_items").select("*").eq("id", body.item_id).maybeSingle();
        if (!cur) return json({ error: "item not found" }, 404);

        const patch: any = {};
        for (const k of ["appointment_type", "assigned_rep", "slot_start", "slot_end", "status", "contract_value", "sale_type", "sale_type_other", "cancel_reason"]) {
          if (k in p) patch[k] = p[k];
        }
        patch.updated_at = new Date().toISOString();

        const warnings: string[] = [];
        if (cur.provider === "ghl" && cur.provider_ref) {
          const newStatus = "status" in patch ? patch.status : cur.status;
          if (newStatus === "cancelled" && cur.status !== "cancelled") {
            const ok = await ghlCancel(cur.service_type, cur.provider_ref);
            if (!ok) warnings.push("Could not cancel the GoHighLevel appointment automatically — cancel it in GHL too.");
          } else if (("slot_start" in patch || "slot_end" in patch)) {
            const s = patch.slot_start ?? cur.slot_start, e = patch.slot_end ?? cur.slot_end;
            if (s && e) {
              const ok = await ghlReschedule(cur.service_type, cur.provider_ref, new Date(s).toISOString(), new Date(e).toISOString());
              if (!ok) warnings.push("Could not reschedule the GoHighLevel appointment automatically — update it in GHL too.");
            }
          }
        }
        const { data, error } = await admin.from("booking_items").update(patch).eq("id", body.item_id).select().single();
        if (error) throw error;
        return json({ ok: true, item: data, warnings });
      }

      // ---------- CANCEL OPPORTUNITY (admin/manager) ----------
      case "cancel": {
        if (!canManage) return json({ error: "not authorized" }, 403);
        if (!body.session_id) return json({ error: "session_id required" }, 400);
        const reason = body.reason ?? null;
        const { data: items } = await admin.from("booking_items").select("*").eq("session_id", body.session_id);
        const warnings: string[] = [];
        for (const it of (items ?? [])) {
          if (it.provider === "ghl" && it.provider_ref && it.status === "booked") {
            const ok = await ghlCancel(it.service_type, it.provider_ref);
            if (!ok) warnings.push(`GHL appt ${it.provider_ref} not cancelled automatically.`);
          }
        }
        const { error } = await admin.from("booking_items")
          .update({ status: "cancelled", cancel_reason: reason, updated_at: new Date().toISOString() })
          .eq("session_id", body.session_id);
        if (error) throw error;
        await admin.from("booking_sessions").update({ updated_at: new Date().toISOString() }).eq("id", body.session_id);
        return json({ ok: true, warnings });
      }

      default:
        return json({ error: "unknown op" }, 400);
    }
  } catch (e) {
    return json({ error: String((e as any)?.message ?? e) }, 500);
  }
});
