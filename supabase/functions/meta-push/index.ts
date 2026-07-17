// meta-push: push an approved creative to a PAUSED Meta ad campaign via the Windsor.ai MCP server.
// Windsor MCP (https://mcp.windsor.ai/) accepts the Windsor API key as a Bearer token and is stateless,
// so we act as an MCP client from the edge: tools/call -> execute_action (connector 'facebook').
// verify_jwt=false; admin/manager only (verify_pin). Body: { actor_id, pin, op?, creative_id }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'};
const json=(b,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{...cors,'Content-Type':'application/json'}});
const sb=createClient(Deno.env.get('SUPABASE_URL'),Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false}});
async function secret(name){ const e=Deno.env.get(name); if(e) return e; try{const {data}=await sb.rpc('get_secret',{p_name:name}); if(data) return String(data);}catch(_){} return ''; }

const WINDSOR_MCP='https://mcp.windsor.ai/';
let _id=1;
async function mcp(method, params){
  const key=await secret('WINDSOR_API_KEY'); if(!key) throw new Error('WINDSOR_API_KEY not set');
  const r=await fetch(WINDSOR_MCP,{ method:'POST', headers:{
    'Authorization':'Bearer '+key, 'Content-Type':'application/json', 'Accept':'application/json, text/event-stream'
  }, body: JSON.stringify({ jsonrpc:'2.0', id:_id++, method, params }) });
  const t=await r.text();
  let payload=null;
  for(const line of t.split(/\r?\n/)){ if(line.startsWith('data:')){ try{ payload=JSON.parse(line.slice(5).trim()); }catch(_){} } }
  if(!payload){ try{ payload=JSON.parse(t); }catch{ throw new Error('windsor: unparseable ('+r.status+') '+t.slice(0,200)); } }
  if(payload.error) throw new Error('windsor: '+(payload.error.message||JSON.stringify(payload.error)));
  return payload.result;
}
async function action(connector, actionId, account, params){
  const res=await mcp('tools/call', { name:'execute_action', arguments:{ connector, action:actionId, account, params } });
  let out=res && res.structuredContent;
  if(out===undefined && res && Array.isArray(res.content)){ const tx=res.content.map((c)=>c&&c.text||'').join(''); try{ out=JSON.parse(tx); }catch{ out={_raw:tx}; } }
  if(res && res.isError) throw new Error('action '+actionId+' failed: '+JSON.stringify(out));
  return out;
}
const findId=(o,...keys)=>{ if(!o) return null; for(const k of keys){ if(o[k]) return String(o[k]); } if(o.id) return String(o.id); if(o.data&&o.data.id) return String(o.data.id); return null; };

Deno.serve(async (req)=>{
  if(req.method==='OPTIONS') return new Response('ok',{headers:cors});
  if(req.method!=='POST') return json({error:'POST only'},405);
  let body; try{ body=await req.json(); }catch{ return json({error:'bad json'},400); }
  const { actor_id, pin, op, creative_id } = body??{};
  if(!actor_id || !pin) return json({error:'actor_id, pin required'},400);
  const { data: auth, error: vErr } = await sb.rpc('verify_pin', { p_user: actor_id, p_pin: String(pin) });
  if(vErr) return json({error:vErr.message},500);
  if(!auth?.ok) return json({error:auth?.error ?? 'invalid pin'},401);
  if(auth.role!=='admin' && auth.role!=='manager') return json({error:'admins only'},403);

  try{
    if(op==='whoami'){ const u=await mcp('tools/call',{name:'get_current_user',arguments:{}}); return json({ ok:true, result:u }); }

    if(!creative_id) return json({error:'creative_id required'},400);
    const { data: cr } = await sb.from('ad_creatives').select('*').eq('id',creative_id).maybeSingle();
    if(!cr) return json({error:'creative not found'},404);
    if(!cr.asset_ref) return json({error:'creative has no image yet — generate the image first'},400);
    const { data: offer } = await sb.from('offers').select('id, campaign_id, cta_direct').eq('id',cr.offer_id).maybeSingle();
    const { data: camp } = await sb.from('campaigns').select('id, name, brand_id').eq('id',offer?.campaign_id).maybeSingle();
    const { data: brand } = await sb.from('brands').select('*').eq('id',camp?.brand_id).maybeSingle();
    if(!brand?.fb_page_id) return json({error:'brand is missing a Facebook Page ID'},400);
    const acct = brand.fb_ad_account_id || '1650188606120291';
    const { data: lp } = await sb.from('landing_pages').select('deploy_url, funnel_id, funnels!inner(offer_id)').eq('funnels.offer_id', offer?.id).not('deploy_url','is',null).limit(1).maybeSingle();
    const link = (lp?.deploy_url && /^https?:/.test(lp.deploy_url)) ? lp.deploy_url : (brand.live_site || 'https://'+(brand.id)+'.com');

    const cname = (camp?.name||'Campaign')+' — '+(cr.headline||'Ad');
    const campRes = await action('facebook','create_campaign', acct, {
      name: cname, objective:'OUTCOME_LEADS', special_ad_categories:[], status:'paused', daily_budget:2000 });
    const metaCampaignId = findId(campRes,'campaign_id','id');
    if(!metaCampaignId) return json({ ok:false, stage:'campaign', result:campRes });
    const adsetParams = { campaign_id:metaCampaignId, name:(camp?.name||'Campaign')+' — Ad set',
      optimization_goal:'OFFSITE_CONVERSIONS', billing_event:'IMPRESSIONS',
      targeting:{ geo_locations:{ countries:['US'] } }, status:'paused' };
    if(brand.fb_pixel_id) adsetParams.promoted_object={ pixel_id:String(brand.fb_pixel_id), custom_event_type:'LEAD' };
    const adsetRes = await action('facebook','create_adset', acct, adsetParams);
    const metaAdsetId = findId(adsetRes,'adset_id','id');
    if(!metaAdsetId) return json({ ok:false, stage:'adset', campaign_id:metaCampaignId, result:adsetRes });
    const adRes = await action('facebook','create_ad', acct, {
      adset_id:metaAdsetId, name:(cr.headline||'Ad'), page_id:String(brand.fb_page_id), link,
      message:cr.primary_text||'', headline:cr.headline||'', description:cr.description||'',
      image_url:cr.asset_ref, call_to_action_type:'LEARN_MORE', status:'paused' });
    const metaAdId = findId(adRes,'ad_id','id');

    await sb.from('ad_creatives').update({ meta_status:'built', meta_ad_id:metaAdId, updated_at:new Date().toISOString() }).eq('id',creative_id);
    try{ await sb.from('meta_campaigns').insert({ id:'mc-'+creative_id, meta_campaign_id:metaCampaignId, funnel_id:cr.funnel_id||null, name:cname, objective:'OUTCOME_LEADS', status:'paused', budget:{type:'daily',amount_usd:20} }); }catch(_){}

    return json({ ok:true, paused:true, meta_campaign_id:metaCampaignId, meta_adset_id:metaAdsetId, meta_ad_id:metaAdId, link });
  }catch(e){
    if(creative_id){ try{ await sb.from('ad_creatives').update({ meta_status:'error' }).eq('id',creative_id); }catch(_){} }
    return json({ ok:false, error:String((e as any)?.message ?? e) },500);
  }
});
