// Supabase Edge Function: clock
// PIN-validated clock in / out. Deployed with verify_jwt = false; auth is the
// per-user PIN, checked server-side with the service-role key.
// Endpoint: POST {SUPABASE_URL}/functions/v1/clock
// Body: { user_id, pin, action: "in" | "out" | "toggle" | "status" }
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
  const { user_id, pin, action } = body ?? {};
  if (!user_id || !pin) return json({ error: 'user_id and pin required' }, 400);

  const { data: auth, error: vErr } = await admin.rpc('verify_pin', { p_user: user_id, p_pin: String(pin) });
  if (vErr) return json({ error: vErr.message }, 500);
  if (!auth?.ok) return json({ error: auth?.error ?? 'invalid pin' }, 401);

  const { data: open } = await admin
    .from('time_entries')
    .select('*')
    .eq('user_id', user_id)
    .is('clock_out', null)
    .order('clock_in', { ascending: false })
    .limit(1)
    .maybeSingle();

  const act = action === 'toggle' ? (open ? 'out' : 'in') : action;

  if (act === 'status') {
    return json({ ok: true, clocked_in: !!open, entry: open ?? null });
  }
  if (act === 'in') {
    if (open) return json({ ok: true, clocked_in: true, entry: open, note: 'already clocked in' });
    const { data, error } = await admin.from('time_entries').insert({ user_id }).select().single();
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, clocked_in: true, entry: data });
  }
  if (act === 'out') {
    if (!open) return json({ ok: true, clocked_in: false, entry: null, note: 'was not clocked in' });
    const { data, error } = await admin
      .from('time_entries')
      .update({ clock_out: new Date().toISOString() })
      .eq('id', open.id).select().single();
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, clocked_in: false, entry: data });
  }
  return json({ error: 'action must be in | out | toggle | status' }, 400);
});
