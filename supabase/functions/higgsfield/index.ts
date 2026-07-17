// higgsfield: generate an ad-creative image via the Higgsfield Cloud API v2 (server-side).
// verify_jwt=false; admin/manager only (verify_pin). Body: { actor_id, pin, op?, prompt, aspect_ratio?, endpoint?, creative_id? }
// Auth to Higgsfield: header `Authorization: Key KEY_ID:KEY_SECRET`. Base https://platform.higgsfield.ai.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'};
const json=(b,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{...cors,'Content-Type':'application/json'}});
const sb=createClient(Deno.env.get('SUPABASE_URL'),Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false}});
async function secret(name){ const e=Deno.env.get(name); if(e) return e; try{const {data}=await sb.rpc('get_secret',{p_name:name}); if(data) return String(data);}catch(_){} return ''; }
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const BASE='https://platform.higgsfield.ai';

async function hf(pathOrUrl, method, keyId, keySecret, body){
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : BASE + pathOrUrl;
  const r=await fetch(url,{ method, headers:{
    'Authorization':'Key '+keyId+':'+keySecret,
    'Content-Type':'application/json',
    'User-Agent':'higgsfield-server-js/2.0',
  }, body: body?JSON.stringify(body):undefined });
  const t=await r.text(); let j; try{ j=JSON.parse(t); }catch{ j={_raw:t.slice(0,800)}; }
  return { httpStatus:r.status, ok:r.ok, j };
}
function pickUrl(d){
  if(!d) return null;
  if(Array.isArray(d.images) && d.images[0] && d.images[0].url) return d.images[0].url;
  if(d.results && d.results.raw && d.results.raw.url) return d.results.raw.url;
  if(Array.isArray(d.jobs) && d.jobs[0] && d.jobs[0].results && d.jobs[0].results.raw) return d.jobs[0].results.raw.url;
  return null;
}

Deno.serve(async (req)=>{
  if(req.method==='OPTIONS') return new Response('ok',{headers:cors});
  if(req.method!=='POST') return json({error:'POST only'},405);
  let body; try{ body=await req.json(); }catch{ return json({error:'bad json'},400); }
  const { actor_id, pin, op, prompt } = body??{};
  if(!actor_id || !pin) return json({error:'actor_id, pin required'},400);
  const { data: auth, error: vErr } = await sb.rpc('verify_pin', { p_user: actor_id, p_pin: String(pin) });
  if(vErr) return json({error:vErr.message},500);
  if(!auth?.ok) return json({error:auth?.error ?? 'invalid pin'},401);
  if(auth.role!=='admin' && auth.role!=='manager') return json({error:'admins only'},403);

  const keyId=await secret('HIGGSFIELD_KEY_ID'), keySecret=await secret('HIGGSFIELD_KEY_SECRET');

  // key presence check (no values exposed)
  if(op==='ping'){ return json({ ok:true, has_key_id:!!keyId, key_id_len:(keyId||'').length, has_secret:!!keySecret, secret_len:(keySecret||'').length }); }

  if(!keyId || !keySecret) return json({ ok:false, error:'Higgsfield keys not set (HIGGSFIELD_KEY_ID / HIGGSFIELD_KEY_SECRET)' },400);

  // probe: hit a candidate path (GET or POST) and return the raw status WITHOUT polling.
  // Used to discover valid model slugs / catalog endpoints. Empty POST body avoids generation/charge.
  if(op==='probe'){
    const ep=(body.endpoint||'').replace(/^\//,'');
    const m=(body.method||'POST').toUpperCase();
    const sub=await hf('/'+ep, m, keyId, keySecret, m==='GET'?undefined:(body.raw_body||{}));
    return json({ endpoint:ep, method:m, http:sub.httpStatus, ok:sub.ok, body:sub.j });
  }

  if(!prompt) return json({error:'prompt required'},400);

  try{
    // Inject the brand's locked creative brief so the scene follows exact colors/style/uniform rules.
    let fullPrompt = prompt;
    if(body.creative_id){
      const { data: cr } = await sb.from('ad_creatives').select('offer_id').eq('id',body.creative_id).maybeSingle();
      const { data: off } = cr ? await sb.from('offers').select('campaign_id').eq('id',cr.offer_id).maybeSingle() : { data:null };
      const { data: camp } = off ? await sb.from('campaigns').select('brand_id').eq('id',off.campaign_id).maybeSingle() : { data:null };
      const { data: brand } = camp ? await sb.from('brands').select('name, creative_brief').eq('id',camp.brand_id).maybeSingle() : { data:null };
      if(brand && brand.creative_brief){
        fullPrompt = `BRAND CREATIVE BRIEF — ${brand.name}. Follow EXACTLY (colors, style, uniform, tone):\n${brand.creative_brief}\n\nGENERATE THIS AD SCENE: ${prompt}\n\nRules: photoreal, on-brand scene using the exact brand colors above. Do NOT render headline text or the logo inside the image (those are composited separately) — keep clean negative space top or bottom for a headline. Realistic Arizona setting per the brief.`;
      }
    }
    const endpoint = body.endpoint || 'flux-pro/kontext/max/text-to-image';
    const input = { prompt: fullPrompt, aspect_ratio: body.aspect_ratio || '1:1', safety_tolerance: 2 };
    const sub = await hf('/'+endpoint.replace(/^\//,''), 'POST', keyId, keySecret, input);
    if(!sub.ok) return json({ ok:false, stage:'submit', http:sub.httpStatus, body:sub.j });

    let data=sub.j;
    let url=pickUrl(data);
    let statusUrl=data.status_url;
    let st=data.status;
    let tries=0;
    while(!url && statusUrl && tries<40 && st!=='failed' && st!=='nsfw' && st!=='canceled'){
      await sleep(3000);
      const poll=await hf(statusUrl,'GET',keyId,keySecret);
      data=poll.j; st=data.status; url=pickUrl(data); statusUrl=data.status_url||statusUrl; tries++;
    }
    if(!url) return json({ ok:false, stage:'poll', status:st, body:data });

    // If a creative_id was passed, write the URL straight back so the dashboard shows it.
    if(body.creative_id){ try{ await sb.from('ad_creatives').update({ asset_ref:url, image_status:'done', updated_at:new Date().toISOString() }).eq('id',body.creative_id); }catch(_){} }
    return json({ ok:true, url });
  }catch(e){ return json({ error:String((e as any)?.message ?? e) },500); }
});
