// ghl-calls-sync: pulls real call records from GoHighLevel (conversations -> TYPE_CALL messages)
// into public.ghl_calls. GHL already collapses Twilio ring-group/softphone legs into ONE call
// message per real call, so this is the clean "call dashboard" data. verify_jwt=false.
// Body: { mode:'recent'|'backfill', before?:ms, pages?:n, sinceDays?:n, budgetMs?:n }
// Each call message carries userId = the GHL user who made/handled it ("Call made by"); stored on
// ghl_calls.user_id and mapped to a name via ghl_users (refreshed here each run).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS' };
const json = (b, s=200) => new Response(JSON.stringify(b), { status:s, headers:{...cors,'Content-Type':'application/json'} });
const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), { auth:{persistSession:false} });

const GHL_BASE = 'https://services.leadconnectorhq.com';
const LOC = Deno.env.get('GHL_LOCATION_ID') || 'z4t41ywW9EayYdtYsUBH';
const V = '2021-04-15';

async function token(){ const e = Deno.env.get('GHL_TOKEN'); if(e) return e; const { data } = await admin.rpc('get_secret',{p_name:'GHL_TOKEN'}); return data as string; }
async function ghlGet(tk, path){ try{ const r = await fetch(`${GHL_BASE}${path}`, { headers:{ Authorization:`Bearer ${tk}`, Version:V, Accept:'application/json' } }); if(!r.ok) return null; return await r.json(); }catch{ return null; } }

// Refresh the GHL user directory (id -> name) so calls can be attributed to a rep by name.
async function refreshUsers(tk){
  try{
    const r = await fetch(`${GHL_BASE}/users/?locationId=${LOC}`, { headers:{ Authorization:`Bearer ${tk}`, Version:'2021-07-28', Accept:'application/json' } });
    if(!r.ok) return;
    const j = await r.json(); const us = (j && j.users) || [];
    if(us.length){ await admin.from('ghl_users').upsert(us.map((u:any)=>({ id:u.id, name:u.name, email:u.email, updated_at:new Date().toISOString() })),{ onConflict:'id' }); }
  }catch(_){}
}

async function callMsgs(tk, convId, cutoffMs){
  const rows:any[] = []; let lastId:string|null = null;
  for(let p=0;p<6;p++){
    const j = await ghlGet(tk, `/conversations/${convId}/messages?limit=100`+(lastId?`&lastMessageId=${lastId}`:''));
    const blk = j && j.messages; const ms = (blk && blk.messages) || [];
    if(ms.length===0) break;
    for(const m of ms){ if(m.messageType==='TYPE_CALL'){ const dt = Date.parse(m.dateAdded||''); if(dt>=cutoffMs) rows.push(m); } }
    const oldest = Date.parse(ms[ms.length-1]?.dateAdded||'') || 0;
    if(!blk.nextPage || oldest < cutoffMs) break;
    lastId = blk.lastMessageId;
  }
  return rows;
}
async function upsertCalls(msgs){
  if(!msgs.length) return 0;
  const rows = msgs.map((m:any)=>({ id:m.id, contact_id:m.contactId||null, conversation_id:m.conversationId||null,
    direction:String(m.direction||'').toLowerCase(),
    call_status:String((m.meta&&m.meta.call&&m.meta.call.status)||m.status||'').toLowerCase(),
    duration:(m.meta&&m.meta.call&&m.meta.call.duration)||0,
    from_num:m.from||null, to_num:m.to||null, user_id:m.userId||null, call_date:m.dateAdded }));
  const { error } = await admin.from('ghl_calls').upsert(rows,{onConflict:'id'});
  if(error) throw error;
  return rows.length;
}
async function getState(k){ const { data } = await admin.from('ghl_sync_state').select('ts,note').eq('k',k).maybeSingle(); return data; }
async function setState(k, tsMs, note){ await admin.from('ghl_sync_state').upsert({ k, ts:new Date(tsMs).toISOString(), note, updated_at:new Date().toISOString() }); }

Deno.serve(async (req)=>{
  if(req.method==='OPTIONS') return new Response('ok',{headers:cors});
  let body:any={}; try{ body = await req.json(); }catch{}
  const mode = body.mode || 'recent';
  const sinceDays = Number(body.sinceDays || 90);
  const cutoffMs = Date.now() - sinceDays*86400000;
  const budgetMs = Number(body.budgetMs || 60000);
  const t0 = Date.now();
  const tk = await token();
  if(!tk) return json({ error:'no GHL token' }, 500);
  await refreshUsers(tk);

  let convScanned=0, convWithCalls=0, callsUpserted=0;

  async function processConv(c){
    const calls = await callMsgs(tk, c.id, cutoffMs);
    convScanned++;
    if(calls.length){ convWithCalls++; callsUpserted += await upsertCalls(calls); }
  }

  try{
    if(mode==='backfill'){
      const bf = await getState('calls_backfill');
      if(bf && bf.note==='done' && !body.before){ return json({ ok:true, mode, skipped:'backfill complete' }); }
      let cursor = Number(body.before || (bf && bf.ts ? Date.parse(bf.ts) : Date.now()));
      const maxPages = Number(body.pages || 3);
      let done=false;
      for(let p=0;p<maxPages;p++){
        if(Date.now()-t0 > budgetMs) break;
        const j = await ghlGet(tk, `/conversations/search?locationId=${LOC}&limit=100&sortBy=last_message_date&sort=desc&startAfterDate=${cursor}`);
        const cs = (j && j.conversations) || [];
        if(cs.length===0){ done=true; break; }
        for(const c of cs){
          const lmd = Number(c.lastMessageDate || (c.sort && c.sort[0]) || 0);
          cursor = lmd;
          if(lmd < cutoffMs){ done=true; break; }
          if(Date.now()-t0 > budgetMs) break;
          await processConv(c);
        }
        if(done) break;
        if(cs.length < 100){ done=true; break; }
      }
      await setState('calls_backfill', cursor, done?'done':'running');
      return json({ ok:true, mode, convScanned, convWithCalls, callsUpserted, nextBefore:cursor, done });
    } else {
      // recent: page newest->older until we reach the stored watermark (or page cap / budget)
      const wmRow = await getState('calls_watermark');
      const watermark = wmRow && wmRow.ts ? Date.parse(wmRow.ts) : 0;
      let cursor = Date.now(); let newest = 0; let stop=false;
      for(let p=0;p<6 && !stop;p++){
        if(Date.now()-t0 > budgetMs) break;
        const j = await ghlGet(tk, `/conversations/search?locationId=${LOC}&limit=100&sortBy=last_message_date&sort=desc&startAfterDate=${cursor}`);
        const cs = (j && j.conversations) || [];
        if(cs.length===0) break;
        for(const c of cs){
          const lmd = Number(c.lastMessageDate || (c.sort && c.sort[0]) || 0);
          if(newest===0) newest = lmd;
          cursor = lmd;
          if(lmd <= watermark){ stop=true; break; }
          if(Date.now()-t0 > budgetMs){ stop=true; break; }
          await processConv(c);
        }
        if(cs.length < 100) break;
      }
      if(newest > watermark) await setState('calls_watermark', newest, 'recent');
      return json({ ok:true, mode, convScanned, convWithCalls, callsUpserted, newWatermark:newest });
    }
  }catch(e){ return json({ error:String((e as any)?.message ?? e), convScanned, callsUpserted }, 500); }
});
