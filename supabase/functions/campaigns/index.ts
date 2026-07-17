// campaigns: admin-only API for the Campaigns board (brand -> design_system -> campaign -> offer -> funnel -> landing_page / ad_creative / meta_campaign).
// verify_jwt=false; PIN validated via public.verify_pin (bcrypt + lockout), then gated to admin/manager.
// Body: { actor_id, pin, op, payload }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'};
const json=(b,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{...cors,'Content-Type':'application/json'}});
const sb=createClient(Deno.env.get('SUPABASE_URL'),Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false}});

const TABLES={
  brands:['id','name','vertical','market','live_site','standing_proof_points','status','design_system_id','note'],
  design_systems:['id','brand_id','design_dna','color_tokens','typography','spacing_rhythm','component_library_ref','reference_doc_ref','brand_assets','source','extra'],
  campaigns:['id','brand_id','name','objective','goal','sales_enablement','attribution','builder','status','start_date','end_date','owner','extra'],
  offers:['id','campaign_id','name','avatar','angle_family','value_stack','pricing','why','cta_direct','cta_transitional','brandscript','channels','status','extra'],
  funnels:['id','offer_id','name','steps','entry_type','crm','status','extra'],
  landing_pages:['id','funnel_id','brand_id','title','type','file_ref','storage_path','html_content','deploy_url','deploy_platform','lead_integration','variant_of','status','extra'],
  ad_creatives:['id','funnel_id','offer_id','format','hook','primary_text','headline','description','asset_ref','status','meta_ad_id','visual_direction','image_status','image_job','usage','meta_status'],
  meta_campaigns:['id','meta_campaign_id','funnel_id','name','objective','status','budget','adsets','metrics','last_synced'],
  campaign_tasks:['id','campaign_id','title','assignee','status','created_by'],
  campaign_comments:['id','campaign_id','author','body'],
};

async function tree(){
  const cols={
    brands:'*', design_systems:'*', campaigns:'*', offers:'*', funnels:'*',
    landing_pages:'id,funnel_id,brand_id,title,type,file_ref,storage_path,deploy_url,deploy_platform,lead_integration,variant_of,status,extra,updated_at',
    ad_creatives:'*', meta_campaigns:'*', campaign_tasks:'*', campaign_comments:'*',
  };
  const out={};
  await Promise.all(Object.entries(cols).map(async ([t,c])=>{
    const { data } = await sb.from(t).select(c).order('id');
    out[t]=data||[];
  }));
  const { data: members } = await sb.from('app_users').select('id, full_name, team, role').eq('is_active',true).order('full_name');
  out['members']=members||[];
  return out;
}

Deno.serve(async (req)=>{
  if(req.method==='OPTIONS') return new Response('ok',{headers:cors});
  if(req.method!=='POST') return json({error:'POST only'},405);
  let body; try{ body=await req.json(); }catch{ return json({error:'bad json'},400); }
  const { actor_id, pin, op, payload } = body??{};

  if(!actor_id || !pin) return json({error:'actor_id, pin required'},400);
  const { data: auth, error: vErr } = await sb.rpc('verify_pin', { p_user: actor_id, p_pin: String(pin) });
  if(vErr) return json({error:vErr.message},500);
  if(!auth?.ok) return json({error:auth?.error ?? 'invalid pin'},401);
  if(auth.role!=='admin' && auth.role!=='manager') return json({error:'admins only'},403);

  try{
    if(op==='tree' || !op){ return json({ ok:true, ...(await tree()) }); }

    if(op==='get_page'){
      const { data } = await sb.from('landing_pages').select('*').eq('id',payload?.id).maybeSingle();
      return json({ ok:true, page:data||null });
    }

    // Save into an allowlisted table with allowlisted columns. Update if the row exists, else insert.
    if(op==='save'){
      const table=payload?.table; const row=payload?.row||{};
      const allow=TABLES[table]; if(!allow) return json({error:'unknown table'},400);
      if(!row.id) return json({error:'row.id required'},400);
      const clean={}; for(const k of allow){ if(k in row) clean[k]=row[k]; }
      clean['updated_at']=new Date().toISOString();
      const { data: existing } = await sb.from(table).select('id').eq('id',clean.id).maybeSingle();
      const res = existing
        ? await sb.from(table).update(clean).eq('id',clean.id).select().maybeSingle()
        : await sb.from(table).insert(clean).select().maybeSingle();
      if(res.error) return json({error:res.error.message},400);
      return json({ ok:true, row:res.data });
    }

    if(op==='delete'){
      const table=payload?.table; const id=payload?.id;
      if(!TABLES[table]) return json({error:'unknown table'},400);
      if(!id) return json({error:'id required'},400);
      const { error } = await sb.from(table).delete().eq('id',id);
      if(error) return json({error:error.message},400);
      return json({ ok:true });
    }

    if(op==='add_task'){
      const { campaign_id, title, assignee } = payload||{};
      if(!campaign_id || !title) return json({error:'campaign_id and title required'},400);
      const { data, error } = await sb.from('campaign_tasks').insert({ campaign_id, title, assignee:assignee||null, created_by:auth.full_name||null, status:'open' }).select().single();
      if(error) return json({error:error.message},400);
      return json({ ok:true, task:data });
    }
    if(op==='update_task'){
      const { id } = payload||{}; if(!id) return json({error:'id required'},400);
      const patch={ updated_at:new Date().toISOString() };
      for(const k of ['title','assignee','status']){ if(k in (payload||{})) patch[k]=payload[k]; }
      const { data, error } = await sb.from('campaign_tasks').update(patch).eq('id',id).select().single();
      if(error) return json({error:error.message},400);
      return json({ ok:true, task:data });
    }
    if(op==='add_comment'){
      const { campaign_id, body:text } = payload||{};
      if(!campaign_id || !text) return json({error:'campaign_id and body required'},400);
      const { data, error } = await sb.from('campaign_comments').insert({ campaign_id, author:auth.full_name||'Someone', body:text }).select().single();
      if(error) return json({error:error.message},400);
      return json({ ok:true, comment:data });
    }

    return json({error:'unknown op: '+op},400);
  }catch(e){ return json({error:String((e as any)?.message ?? e)},500); }
});
