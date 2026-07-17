// marketing: Windsor.ai (cached) + booking opportunities (live) + FB campaigns + Thumbtack webhook leads + Twilio calls. verify_jwt=false.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'};
const json=(b,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{...cors,'Content-Type':'application/json'}});
const sb=createClient(Deno.env.get('SUPABASE_URL'),Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false}});
async function secret(name){ const e=Deno.env.get(name); if(e) return e; try{const {data}=await sb.rpc('get_secret',{p_name:name}); if(data) return String(data);}catch(_){} return ''; }
const N=v=>{ const n=Number(v); return isFinite(n)?n:0; };
const CACHE_MIN=20;
function channelFrom(text){ const s=(text||'').toLowerCase(); if(!s.trim()) return null;
  if(s.includes('facebook')||s.includes('fb ad')||s.includes('fb lead')||s.includes(' fb ')||s.includes('meta')||s.includes('instagram')||s.includes(' ig ')) return 'Meta';
  if(s.includes('thumbtack')) return 'Thumbtack';
  if(s.includes('lsa')||s.includes('local service')) return 'Google LSA';
  if(s.includes('contact form')||s.includes('website')||s.includes('inbound')||s.includes('form')) return 'Website / Forms';
  if(s.includes('affiliate')) return 'Affiliate';
  if(s.includes('organic')) return 'Organic social';
  if(s.includes('jobsite')) return 'Jobsite';
  if(s.includes('eddm')||s.includes('direct mail')) return 'EDDM';
  if(s.includes('b2b')) return 'B2B Affiliate';
  if(s.includes('google')) return 'Google';
  return null; }
const CH={meta_ads:'Facebook / Meta Ads',lsa:'Google LSA',thumbtack:'Thumbtack',outbound_calling:'Outbound calling',organic_social:'Organic social',jobsite_marketing:'Jobsite marketing',eddm:'EDDM',b2b_affiliate:'B2B Affiliate',other:'Other'};
const COMP={hvac:'Everest',plumbing:'Everest',roofing:'Advosy Construction (VRZA)',restoration:'Bloque',pest_control:'Pestkee'};
function presetRange(preset){ const m=/^last_(\d+)d/.exec(preset||''); const days=m?parseInt(m[1]):30; const end=new Date(); const start=new Date(end.getTime()-days*86400000); return [start.toISOString(),end.toISOString()]; }
const CALL_ANSWERED = st => { const s=(st||'').toLowerCase(); return s==='completed'||s==='in-progress'||s==='answered'; };

const FB_UNIVERSE_PRESET='last_90d';
async function fetchWindsor(key, dparam, startISO, endISO){
  async function win(connector, fields, extra, dparamOverride){ const dp=dparamOverride||dparam; const url=`https://connectors.windsor.ai/${connector}?api_key=${encodeURIComponent(key)}&${dp}&fields=${encodeURIComponent(fields)}`+(extra||''); try{ const r=await fetch(url); const j=await r.json(); return (j&&j.data)||[]; }catch(e){ return []; } }
  const _ymd=iso=>{ const d=new Date(iso); return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0')+'-'+String(d.getUTCDate()).padStart(2,'0'); };
  const _fbTo=new Date(endISO); _fbTo.setUTCDate(_fbTo.getUTCDate()-1);
  const fbDparam=`date_from=${_ymd(startISO)}&date_to=${_ymd(_fbTo.toISOString())}`;
  const [ga, ghl, sc, fbCore, fbLeadRows, fbcCore, fbcLeadRows, fbUniv] = await Promise.all([
    win('google_ads','account_name,spend,clicks,impressions,conversions'),
    win('gohighlevel','contact_id,contact_date_added,contact_source,contact_tags','&_maximum=100000'),
    win('searchconsole','account_name,clicks,impressions,position'),
    win('facebook','account_name,spend,clicks,impressions','',fbDparam),
    win('facebook','account_name,actions_lead','',fbDparam),
    win('facebook','campaign,spend,impressions,clicks','',fbDparam),
    win('facebook','campaign,actions_lead','',fbDparam),
    win('facebook','campaign','',`date_preset=${FB_UNIVERSE_PRESET}`),
  ]);
  const fb=(fbCore||[]).map(r=>({account_name:r.account_name, spend:N(r.spend), clicks:N(r.clicks), impressions:N(r.impressions)}));
  const startMs=new Date(startISO).getTime(), endMs=new Date(endISO).getTime();
  const seen={};
  for(const r of (ghl||[])){
    const added=r.contact_date_added; if(!added) continue;
    const t=new Date(added).getTime();
    if(!(t>=startMs && t<endMs)) continue;
    const id=r.contact_id||('row'+Object.keys(seen).length);
    if(!(id in seen)){ const tags=Array.isArray(r.contact_tags)?r.contact_tags.join(' '):(r.contact_tags||''); seen[id]={src:r.contact_source||'', tags}; }
  }
  const buckets={}; let unqualifiedContacts=0;
  for(const id in seen){ const {src,tags}=seen[id]; const ch=channelFrom(src+' '+tags);
    if(ch){ buckets[ch]=(buckets[ch]||0)+1; } else { unqualifiedContacts++; } }
  const leads=Object.entries(buckets).map(([source,n])=>({source,n})).sort((a,b)=>b.n-a.n);
  const totalLeads=Object.values(buckets).reduce((a,n)=>a+n,0);
  const totalContacts=Object.keys(seen).length; const metaLeads=buckets['Meta']||0; const metaSpend=(fb||[]).reduce((a,r)=>a+N(r.spend),0);
  const paid=[];
  (ga||[]).forEach(r=>paid.push({src:r.account_name, channel:/lsa/i.test(r.account_name||'')?'Google LSA':'Google Ads', ctag:/lsa/i.test(r.account_name||'')?'l':'g', spend:N(r.spend), clicks:N(r.clicks), impressions:N(r.impressions), leads:N(r.conversions), platform:true}));
  (fb||[]).forEach(r=>paid.push({src:r.account_name, channel:'Meta Ads', ctag:'m', spend:r.spend, clicks:r.clicks, impressions:r.impressions, leads:metaLeads, platform:false}));
  paid.sort((a,b)=>b.spend-a.spend);
  const fbcLeadBy={}; (fbcLeadRows||[]).forEach(r=>{ const k=r.campaign||'(unnamed)'; fbcLeadBy[k]=(fbcLeadBy[k]||0)+N(r.actions_lead); });
  const fbcMap={};
  (fbcCore||[]).forEach(r=>{ const k=r.campaign||'(unnamed)'; const o=fbcMap[k]||(fbcMap[k]={campaign:k,spend:0,impressions:0,clicks:0,leads:0}); o.spend+=N(r.spend); o.impressions+=N(r.impressions); o.clicks+=N(r.clicks); });
  (fbUniv||[]).forEach(r=>{ const k=r.campaign||'(unnamed)'; if(!(k in fbcMap)) fbcMap[k]={campaign:k,spend:0,impressions:0,clicks:0,leads:0}; });
  for(const k in fbcMap){ fbcMap[k].leads=fbcLeadBy[k]||0; }
  const fbCampaigns=Object.values(fbcMap).sort((a,b)=>(b.spend-a.spend)||(b.impressions-a.impressions)||String(a.campaign).localeCompare(String(b.campaign)));
  const byhost={};
  (sc||[]).forEach(r=>{ const site=r.account_name||r.account||r.url||'All domains'; const o=byhost[site]||(byhost[site]={site,clicks:0,impressions:0,wpos:0}); o.clicks+=N(r.clicks); o.impressions+=N(r.impressions); o.wpos+=N(r.position)*N(r.impressions); });
  const organic=Object.values(byhost).map(o=>({site:o.site,clicks:o.clicks,impressions:o.impressions,position:o.impressions?o.wpos/o.impressions:0})).filter(o=>o.clicks>0||o.impressions>0).sort((a,b)=>b.clicks-a.clicks);
  // Reconcile Meta spend: Windsor's account-level and campaign-level FB pulls fail independently.
  // If the account-level Meta row is missing from `paid` but campaigns have spend, add a Meta row so
  // Facebook is always represented in the paid table AND the total. Only adds when absent (no double-count).
  const fbCampSpend=fbCampaigns.reduce((a,r)=>a+N(r.spend),0);
  if(!paid.some(r=>r.ctag==='m') && fbCampSpend>0){
    paid.push({src:'Advosy Meta Ads', channel:'Meta Ads', ctag:'m', spend:fbCampSpend, clicks:fbCampaigns.reduce((a,r)=>a+N(r.clicks),0), impressions:fbCampaigns.reduce((a,r)=>a+N(r.impressions),0), leads:metaLeads, platform:false});
    paid.sort((a,b)=>b.spend-a.spend);
  }
  const metaSpendFinal=Math.max(N(metaSpend), fbCampSpend);
  const fbConnected = (fb.length>0) || (fbCampaigns.length>0);
  return { leads, totalLeads, unqualifiedContacts, totalContacts, metaLeads, metaSpend:metaSpendFinal, paid, fbCampaigns, fbConnected, organic };
}

async function ghlCalls(startISO, endISO){
  const empty={ inbound:0,inbound_answered:0,inbound_missed:0,outbound:0,outbound_connected:0,outbound_noanswer:0,total:0,answered:0,missed:0,answered_pct:0,inbound_answer_rate:0,outbound_connect_rate:0, byUser:[], source:'gohighlevel' };
  try{
    const [{ data: cc }, { data: us }] = await Promise.all([
      sb.from('ghl_calls').select('direction, call_status, user_id').gte('call_date',startISO).lt('call_date',endISO),
      sb.from('ghl_users').select('id, name'),
    ]);
    const uname={}; for(const u of (us||[])) uname[u.id]=u.name;
    let inb=0,inbA=0,outb=0,outA=0; const byU={};
    const blank=uid=>({ user_id:uid, name: uid?(uname[uid]||'Unknown user'):'Unassigned', inbound:0,inbound_answered:0,inbound_missed:0,outbound:0,outbound_connected:0,outbound_noanswer:0,total:0,answered:0,missed:0 });
    for(const r of (cc||[])){ const d=(r.direction||''); const a=(r.call_status||'')==='completed'; const uid=r.user_id||null;
      const u=byU[uid]||(byU[uid]=blank(uid)); u.total++; if(a)u.answered++; else u.missed++;
      if(d==='inbound'){ inb++; u.inbound++; if(a){inbA++;u.inbound_answered++;} else u.inbound_missed++; }
      else if(d==='outbound'){ outb++; u.outbound++; if(a){outA++;u.outbound_connected++;} else u.outbound_noanswer++; } }
    const tot=inb+outb, tA=inbA+outA;
    const byUser=Object.values(byU).map(u=>({ ...u,
      inbound_answer_rate: u.inbound?Math.round(u.inbound_answered/u.inbound*1000)/10:0,
      outbound_connect_rate: u.outbound?Math.round(u.outbound_connected/u.outbound*1000)/10:0 }))
      .sort((a,b)=> b.total-a.total || String(a.name).localeCompare(String(b.name)));
    return { inbound:inb, inbound_answered:inbA, inbound_missed:inb-inbA, outbound:outb, outbound_connected:outA, outbound_noanswer:outb-outA,
      total:tot, answered:tA, missed:tot-tA, answered_pct: tot?Math.round(tA/tot*1000)/10:0,
      inbound_answer_rate: inb?Math.round(inbA/inb*1000)/10:0, outbound_connect_rate: outb?Math.round(outA/outb*1000)/10:0, byUser, source:'gohighlevel' };
  }catch(e){ return empty; }
}

Deno.serve(async (req)=>{
  if(req.method==='OPTIONS') return new Response('ok',{headers:cors});
  if(req.method!=='POST') return json({error:'POST only'},405);
  let body; try{ body=await req.json(); }catch{ return json({error:'bad json'},400); }
  const { actor_id, pin } = body??{};
  const preset=(body&&body.date_preset)||'last_30d';
  const dateFrom=body&&body.date_from, dateTo=body&&body.date_to; const useRange=!!(dateFrom&&dateTo);
  const refresh=!!(body&&body.refresh);
  if(actor_id){ const { data: auth, error: vErr } = await sb.rpc('verify_pin',{p_user:actor_id,p_pin:String(pin)});
    if(vErr) return json({error:vErr.message},500);
    if(!auth||!auth.ok) return json({error:(auth&&auth.error)||'invalid pin'},401);
  } else if(!refresh){ return json({error:'actor_id, pin required'},400); }

  const rangeKey = useRange ? `${dateFrom}|${dateTo}` : preset;
  let startISO, endISO;
  if(useRange){ startISO=new Date(dateFrom+'T00:00:00Z').toISOString(); const e=new Date(dateTo+'T00:00:00Z'); e.setUTCDate(e.getUTCDate()+1); endISO=e.toISOString(); }
  else { [startISO,endISO]=presetRange(preset); }

  let opportunities={ total:0, inbound:0, outbound:0, byCompany:[], byPlatform:Object.keys(CH).map(k=>({key:k,label:CH[k],n:0})) };
  try{
    const { data: items } = await sb.from('booking_items').select('service_type, created_at, booking_sessions(source, channel)').eq('status','booked').gte('created_at',startISO).lt('created_at',endISO);
    const its=items||[]; let inb=0,outb=0; const compMap={}, platMap={};
    for(const it of its){ const s=it.booking_sessions||{}; const team=s.source; const ch=s.channel||'other';
      if(team==='inbound')inb++; else if(team==='outbound')outb++;
      const comp=COMP[it.service_type]||it.service_type;
      const c=compMap[comp]||(compMap[comp]={company:comp,inbound:0,outbound:0,total:0}); c.total++; if(team==='inbound')c.inbound++; else if(team==='outbound')c.outbound++;
      platMap[ch]=(platMap[ch]||0)+1; }
    opportunities={ total:its.length, inbound:inb, outbound:outb, byCompany:Object.values(compMap).sort((a,b)=>b.total-a.total), byPlatform:Object.keys(CH).map(k=>({key:k,label:CH[k],n:platMap[k]||0})) };
  }catch(e){}

  const key=await secret('WINDSOR_API_KEY');
  const empty={ leads:[], totalLeads:0, unqualifiedContacts:0, totalContacts:0, metaLeads:0, metaSpend:0, paid:[], fbCampaigns:[], fbConnected:false, organic:[] };
  let w=empty, cached=false, windsorOk=!!key;
  if(key){
    const dparam = useRange ? `date_from=${encodeURIComponent(dateFrom)}&date_to=${encodeURIComponent(dateTo)}` : `date_preset=${encodeURIComponent(preset)}`;
    if(!refresh){ const { data: c } = await sb.from('marketing_cache').select('payload, fetched_at').eq('range_key',rangeKey).maybeSingle();
      if(c && (Date.now()-new Date(c.fetched_at).getTime() < CACHE_MIN*60000)){ w=c.payload; cached=true; } }
    if(!cached){ w=await fetchWindsor(key, dparam, startISO, endISO); try{ await sb.from('marketing_cache').upsert({range_key:rangeKey, payload:w, fetched_at:new Date().toISOString()}); }catch(e){} }
  }
  const calls = await ghlCalls(startISO, endISO);

  let thumbtack={ total:0, cost:0, byCompany:[] };
  try{
    const { data: tt } = await sb.from('thumbtack_leads').select('company, price, received_at').gte('received_at',startISO).lt('received_at',endISO);
    const rows=tt||[]; const byc={}; let cost=0;
    for(const r of rows){ const c=r.company||'Unknown'; const o=byc[c]||(byc[c]={company:c,n:0,cost:0}); o.n++; o.cost+=N(r.price); cost+=N(r.price); }
    thumbtack={ total:rows.length, cost, byCompany:Object.values(byc).sort((a,b)=>b.n-a.n) };
  }catch(e){}

  // Outbound-rep commissions in the selected range — counted as a cost to acquire the lead.
  // "Outbound reps" = app_users with team='outbound'. commissions.created_at is when the deal was booked.
  let outboundCommissions=0, outboundCommissionCount=0;
  try{
    const { data: obu } = await sb.from('app_users').select('id').eq('team','outbound');
    const ids=(obu||[]).map(u=>u.id);
    if(ids.length){
      const { data: cm } = await sb.from('commissions').select('amount').in('user_id',ids).gte('created_at',startISO).lt('created_at',endISO);
      for(const r of (cm||[])){ outboundCommissions+=N(r.amount); outboundCommissionCount++; }
    }
  }catch(e){}

  let leads=(w.leads||[]).slice(); let totalLeads=w.totalLeads||0;
  if(thumbtack.total>0){ const i=leads.findIndex(l=>l.source==='Thumbtack'); if(i>=0){ totalLeads-=leads[i].n; leads.splice(i,1); } leads.push({source:'Thumbtack', n:thumbtack.total, cost:thumbtack.cost}); totalLeads+=thumbtack.total; leads.sort((a,b)=>b.n-a.n); }
  const googleLeads=(w.paid||[]).filter(r=>r.ctag==='g'||r.ctag==='l').reduce((a,r)=>a+N(r.leads),0);
  if(googleLeads>0){ const i=leads.findIndex(l=>l.source==='Google LSA'||l.source==='Google'); if(i>=0){ totalLeads-=leads[i].n; leads.splice(i,1); } leads.push({source:'Google LSA', n:googleLeads}); totalLeads+=googleLeads; leads.sort((a,b)=>b.n-a.n); }

  return json({ ok:true, windsor:windsorOk, cached, range:useRange?`${dateFrom} → ${dateTo}`:preset, opportunities, ...w, leads, totalLeads, thumbtack, outboundCommissions, outboundCommissionCount, calls, twilio:calls });
});
