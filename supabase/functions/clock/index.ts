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

// Central PIN check: bcrypt compare + brute-force lockout live in public.verify_pin.
async function verifyPin(userId: string, pin: string): Promise<{ ok: boolean; error?: string; role?: string; full_name?: string }> {
  const { data, error } = await admin.rpc('verify_pin', { p_user: userId, p_pin: String(pin) });
  if (error) return { ok: false, error: error.message };
  return data as any;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const { user_id, pin, action } = body ?? {};
  if (!user_id || !pin) return json({ error: 'user_id and pin required' }, 400);

  const auth = await verifyPin(user_id, pin);
  if (!auth.ok) return json({ error: auth.error ?? 'invalid pin' }, 401);

  // Self-service PIN reset: rep authenticates with current pin, sets a new one (stored bcrypt-hashed).
  if (action === 'set_pin') {
    const np = String(body.new_pin ?? '').trim();
    if (!/^\d{4,6}$/.test(np)) return json({ error: 'New PIN must be 4 to 6 digits.' }, 400);
    if (np === '1234') return json({ error: 'Choose a PIN other than the temporary 1234.' }, 400);
    const { data: hashed, error: hErr } = await admin.rpc('hash_pin', { p_pin: np });
    if (hErr) return json({ error: hErr.message }, 500);
    const { error } = await admin.from('app_users').update({ pin: hashed }).eq('id', user_id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, pin_updated: true });
  }

  // find current open shift
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
      .eq('id', open.id)
      .select()
      .single();
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, clocked_in: false, entry: data });
  }

  return json({ error: 'action must be in | out | toggle | status | set_pin' }, 400);
});
