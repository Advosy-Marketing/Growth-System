// Supabase Edge Function: admin
// PIN-validated management for admins/managers. verify_jwt = false; the actor's
// PIN + role are checked server-side with the service-role key.
// Endpoint: POST {SUPABASE_URL}/functions/v1/admin
// Body: { actor_id, pin, op, payload }
//   op: add_rep | update_rep | delete_rep | set_rate | edit_entry
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const { actor_id, pin, op, payload } = body ?? {};
  if (!actor_id || !pin || !op) return json({ error: 'actor_id, pin, op required' }, 400);

  const { data: vAuth, error: vErr } = await admin.rpc('verify_pin', { p_user: actor_id, p_pin: String(pin) });
  if (vErr) return json({ error: vErr.message }, 500);
  if (!vAuth?.ok) return json({ error: vAuth?.error ?? 'invalid pin' }, 401);
  const actor = { id: actor_id, role: vAuth.role, is_active: true };
  if (!['admin', 'manager'].includes(actor.role)) return json({ error: 'not authorized' }, 403);
  const isAdmin = actor.role === 'admin';
  const p = payload ?? {};

  try {
    switch (op) {
      case 'add_rep': {
        if (!p.full_name || !p.pin) return json({ error: 'full_name and pin required' }, 400);
        const { data, error } = await admin.from('app_users').insert({
          full_name: p.full_name, team: p.team ?? null, role: p.role ?? 'rep',
          pin: (await admin.rpc('hash_pin', { p_pin: String(p.pin) })).data, hourly_rate: p.hourly_rate ?? null, color: p.color ?? null, is_active: true,
        }).select('id, full_name, team, role, hourly_rate, color, is_active').single();
        if (error) throw error;
        return json({ ok: true, rep: data });
      }
      case 'update_rep': {
        if (!p.id) return json({ error: 'id required' }, 400);
        const patch: any = {};
        for (const k of ['full_name', 'team', 'role', 'hourly_rate', 'color', 'is_active']) if (k in p) patch[k] = p[k];
        if (p.pin) patch.pin = (await admin.rpc('hash_pin', { p_pin: String(p.pin) })).data;
        const { data, error } = await admin.from('app_users').update(patch).eq('id', p.id)
          .select('id, full_name, team, role, hourly_rate, color, is_active').single();
        if (error) throw error;
        return json({ ok: true, rep: data });
      }
      case 'delete_rep': {
        if (!isAdmin) return json({ error: 'admin only' }, 403);
        if (!p.id) return json({ error: 'id required' }, 400);
        const { error } = await admin.from('app_users').delete().eq('id', p.id);
        if (error) throw error;
        return json({ ok: true });
      }
      case 'set_rate': {
        if (!p.appointment_type) return json({ error: 'appointment_type required' }, 400);
        const { data, error } = await admin.from('commission_rates')
          .update({ amount: p.amount, updated_at: new Date().toISOString() })
          .eq('appointment_type', p.appointment_type).select().single();
        if (error) throw error;
        return json({ ok: true, rate: data });
      }
      case 'edit_entry': {
        if (!p.id) return json({ error: 'id required' }, 400);
        const patch: any = {};
        if (p.clock_in) patch.clock_in = p.clock_in;
        if ('clock_out' in p) patch.clock_out = p.clock_out;
        if ('note' in p) patch.note = p.note;
        const { data, error } = await admin.from('time_entries').update(patch).eq('id', p.id).select().single();
        if (error) throw error;
        return json({ ok: true, entry: data });
      }
      default:
        return json({ error: 'unknown op' }, 400);
    }
  } catch (e) {
    return json({ error: String((e as any)?.message ?? e) }, 500);
  }
});
