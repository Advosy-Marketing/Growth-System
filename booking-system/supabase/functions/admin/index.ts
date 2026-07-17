// Supabase Edge Function: admin (PIN-validated). verify_jwt=false.
// Body: { actor_id, pin, op, payload }
// ops: add_rep | update_rep | delete_rep | set_rate | edit_entry | get_matrix | set_matrix | report | set_hours
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const { actor_id, pin, op, payload } = body ?? {};
  if (!actor_id || !pin || !op) return json({ error: 'actor_id, pin, op required' }, 400);

  const { data: vAuth, error: vErr } = await admin.rpc('verify_pin', { p_user: actor_id, p_pin: String(pin) });
  if (vErr) return json({ error: vErr.message }, 500);
  if (!vAuth?.ok) return json({ error: vAuth?.error ?? 'invalid pin' }, 401);
  const actor = { id: actor_id, role: vAuth.role, is_active: true };

  // ---- Self-service: any active rep can pull ONLY their own pay/commission for a period ----
  // (handled before the admin/manager gate so reps can see their own paycheck)
  if (op === 'my_pay') {
    try {
      const start = (payload ?? {}).start, end = (payload ?? {}).end;
      if (!start || !end) return json({ error: 'start and end (ISO) required' }, 400);
      const startMs = new Date(start).getTime(), endMs = new Date(end).getTime();
      const startISO = new Date(start).toISOString(), endISO = new Date(end).toISOString();
      const windowStart = new Date(startMs - 14 * 86400000).toISOString();
      const [eRes, cRes, oRes] = await Promise.all([
        admin.from('time_entries').select('id, user_id, clock_in, clock_out').eq('user_id', actor.id).gte('clock_in', windowStart).lt('clock_in', end),
        admin.from('commissions').select('id, amount, created_at, appointment_type, service_type, user_id, booking_items(slot_start, booking_sessions(source, channel, campaign, customers(name, phone, address)))').eq('user_id', actor.id).gte('created_at', start).lt('created_at', end).order('created_at', { ascending: false }),
        admin.from('hours_overrides').select('user_id, hours').eq('user_id', actor.id).eq('period_start', startISO).eq('period_end', endISO),
      ]);
      const { data: me } = await admin.from('app_users').select('id, full_name, team, role, hourly_rate, color').eq('id', actor.id).maybeSingle();
      const entries = eRes.data ?? [], comms = cRes.data ?? [];
      const overridden = (oRes.data ?? []).length > 0;
      const now = Date.now();
      let ms = 0;
      for (const e of entries) {
        const a = new Date(e.clock_in).getTime();
        const b = e.clock_out ? new Date(e.clock_out).getTime() : now;
        ms += Math.max(0, Math.min(b, endMs) - Math.max(a, startMs));
      }
      const clocked_hours = ms / 3600000;
      const hours = overridden ? Number((oRes.data ?? [])[0].hours) : clocked_hours;
      const rate = Number(me?.hourly_rate || 0);
      const hourly_pay = hours * rate;
      const commission = comms.reduce((s, c) => s + Number(c.amount), 0);
      const repRow = { id: me?.id, full_name: me?.full_name, team: me?.team, role: me?.role, color: me?.color, hourly_rate: rate, hours, clocked_hours, hours_overridden: overridden, appts: comms.length, commission, hourly_pay, total: hourly_pay + commission };
      const detail = comms.map(c => {
        const bi = c.booking_items || {}; const bs = bi.booking_sessions || {}; const cu = bs.customers || {};
        return { rep: me?.full_name || 'You', user_id: c.user_id, customer: cu.name || '—', phone: cu.phone || '', address: cu.address || '', service_type: c.service_type, appointment_type: c.appointment_type, appt_date: bi.slot_start || null, created_at: c.created_at, amount: Number(c.amount), source: bs.source || '', channel: bs.channel || '', campaign: bs.campaign || '' };
      });
      return json({ ok: true, range: { start, end }, me: repRow, detail });
    } catch (e) {
      return json({ error: String(e?.message ?? e) }, 500);
    }
  }

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
        const patch = {};
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
        const patch = {};
        if (p.clock_in) patch.clock_in = p.clock_in;
        if ('clock_out' in p) patch.clock_out = p.clock_out;
        if ('note' in p) patch.note = p.note;
        const { data, error } = await admin.from('time_entries').update(patch).eq('id', p.id).select().single();
        if (error) throw error;
        return json({ ok: true, entry: data });
      }
      // Manually set (override) a rep's total hours for an exact period. Pass
      // hours = null / '' to clear the override and revert to clocked hours.
      case 'set_hours': {
        const userId = p.user_id, start = p.start, end = p.end;
        if (!userId || !start || !end) return json({ error: 'user_id, start, end required' }, 400);
        const startISO = new Date(start).toISOString(), endISO = new Date(end).toISOString();
        if (p.hours === null || p.hours === '' || typeof p.hours === 'undefined') {
          const { error } = await admin.from('hours_overrides').delete()
            .eq('user_id', userId).eq('period_start', startISO).eq('period_end', endISO);
          if (error) throw error;
          return json({ ok: true, cleared: true });
        }
        const hrs = Number(p.hours);
        if (!isFinite(hrs) || hrs < 0) return json({ error: 'hours must be a non-negative number' }, 400);
        const { data, error } = await admin.from('hours_overrides').upsert({
          user_id: userId, period_start: startISO, period_end: endISO, hours: hrs,
          updated_by: actor_id, updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id,period_start,period_end' }).select().single();
        if (error) throw error;
        return json({ ok: true, override: data });
      }
      case 'get_matrix': {
        const [mx, cat] = await Promise.all([
          admin.from('commission_matrix').select('service_type, appointment_type, amount'),
          admin.from('service_catalog').select('service_type, label, appointment_types').eq('is_active', true),
        ]);
        return json({ ok: true, matrix: mx.data ?? [], catalog: cat.data ?? [] });
      }
      case 'set_matrix': {
        if (!p.service_type || !p.appointment_type) return json({ error: 'service_type and appointment_type required' }, 400);
        const { data, error } = await admin.from('commission_matrix')
          .upsert({ service_type: p.service_type, appointment_type: p.appointment_type, amount: Number(p.amount) || 0, updated_at: new Date().toISOString() }, { onConflict: 'service_type,appointment_type' })
          .select().single();
        if (error) throw error;
        return json({ ok: true, cell: data });
      }
      case 'report': {
        const start = p.start, end = p.end;
        if (!start || !end) return json({ error: 'start and end (ISO) required' }, 400);
        const startMs = new Date(start).getTime(), endMs = new Date(end).getTime();
        const startISO = new Date(start).toISOString(), endISO = new Date(end).toISOString();
        const windowStart = new Date(startMs - 14 * 86400000).toISOString();
        const [uRes, eRes, cRes, oRes] = await Promise.all([
          admin.from('app_users').select('id, full_name, team, role, hourly_rate, color').eq('is_active', true),
          admin.from('time_entries').select('id, user_id, clock_in, clock_out').gte('clock_in', windowStart).lt('clock_in', end),
          admin.from('commissions').select('id, amount, created_at, appointment_type, service_type, user_id, booking_items(slot_start, booking_sessions(source, channel, campaign, customers(name, phone, address)))').gte('created_at', start).lt('created_at', end).order('created_at', { ascending: false }),
          admin.from('hours_overrides').select('user_id, hours').eq('period_start', startISO).eq('period_end', endISO),
        ]);
        const users = uRes.data ?? [], entries = eRes.data ?? [], comms = cRes.data ?? [];
        const overrideBy = Object.fromEntries((oRes.data ?? []).map(o => [o.user_id, Number(o.hours)]));
        const uById = Object.fromEntries(users.map(u => [u.id, u]));
        const now = Date.now();
        const reps = users.map(u => {
          let ms = 0;
          for (const e of entries) {
            if (e.user_id !== u.id) continue;
            const a = new Date(e.clock_in).getTime();
            const b = e.clock_out ? new Date(e.clock_out).getTime() : now;
            ms += Math.max(0, Math.min(b, endMs) - Math.max(a, startMs));
          }
          const myC = comms.filter(c => c.user_id === u.id);
          const commission = myC.reduce((s, c) => s + Number(c.amount), 0);
          const clocked_hours = ms / 3600000;
          const overridden = u.id in overrideBy;
          const hours = overridden ? overrideBy[u.id] : clocked_hours;
          const rate = Number(u.hourly_rate || 0);
          const hourly_pay = hours * rate;
          return { id: u.id, full_name: u.full_name, team: u.team, role: u.role, color: u.color, hourly_rate: rate, hours, clocked_hours, hours_overridden: overridden, appts: myC.length, commission, hourly_pay, total: hourly_pay + commission };
        }).sort((a, b) => b.total - a.total);
        const detail = comms.map(c => {
          const bi = c.booking_items || {}; const bs = bi.booking_sessions || {}; const cu = bs.customers || {};
          return { rep: uById[c.user_id]?.full_name || '(unattributed)', user_id: c.user_id, customer: cu.name || '—', phone: cu.phone || '', address: cu.address || '', service_type: c.service_type, appointment_type: c.appointment_type, appt_date: bi.slot_start || null, created_at: c.created_at, amount: Number(c.amount), source: bs.source || '', channel: bs.channel || '', campaign: bs.campaign || '' };
        });
        const totals = reps.reduce((a, r) => ({ hours: a.hours + r.hours, appts: a.appts + r.appts, commission: a.commission + r.commission, hourly_pay: a.hourly_pay + r.hourly_pay, total: a.total + r.total }), { hours: 0, appts: 0, commission: 0, hourly_pay: 0, total: 0 });
        return json({ ok: true, range: { start, end }, reps, detail, totals });
      }
      default:
        return json({ error: 'unknown op' }, 400);
    }
  } catch (e) {
    return json({ error: String(e?.message ?? e) }, 500);
  }
});
