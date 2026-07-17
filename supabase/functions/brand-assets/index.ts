// brand-assets: admin-managed per-brand asset store (logos, uniforms, vehicle wraps, brand photos)
// + per-brand component-library HTML for the landing generator.
// Uploads to the public 'brand-assets' Storage bucket and records rows in brand_assets.
// verify_jwt=false; admin/manager only (verify_pin). ops: list | set_component_html | upload | update | delete
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'};
const json=(b,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{...cors,'Content-Type':'application/json'}});
const sb=createClient(Deno.env.get('SUPABASE_URL'),Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false}});
const BUCKET='brand-assets';
const CT={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',svg:'image/svg+xml',gif:'image/gif',pdf:'application/pdf',woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',otf:'font/otf'};

Deno.serve(async (req)=>{
  if(req.method==='OPTIONS') return new Response('ok',{headers:cors});
  if(req.method!=='POST') return json({error:'POST only'},405);
  let body; try{ body=await req.json(); }catch{ return json({error:'bad json'},400); }
  const { actor_id, pin, op } = body??{};
  if(!actor_id || !pin) return json({error:'actor_id, pin required'},400);
  const { data: auth, error: vErr } = await sb.rpc('verify_pin', { p_user: actor_id, p_pin: String(pin) });
  if(vErr) return json({error:vErr.message},500);
  if(!auth?.ok) return json({error:auth?.error ?? 'invalid pin'},401);
  if(auth.role!=='admin' && auth.role!=='manager') return json({error:'admins only'},403);

  try{
    if(op==='list'){
      let q=sb.from('brand_assets').select('*').order('created_at',{ascending:false});
      if(body.brand_id) q=q.eq('brand_id',body.brand_id);
      const { data } = await q;
      let design_html_len=0;
      if(body.brand_id){ const { data:ds }=await sb.from('design_systems').select('component_html').eq('brand_id',body.brand_id).maybeSingle(); design_html_len=(ds&&ds.component_html)?ds.component_html.length:0; }
      return json({ ok:true, assets:data||[], design_html_len });
    }

    // store a brand's real component library / styleguide HTML (fed verbatim into the landing generator).
    if(op==='set_component_html'){
      const { brand_id, html } = body;
      if(!brand_id || typeof html!=='string') return json({error:'brand_id and html required'},400);
      const { data: existing } = await sb.from('design_systems').select('id').eq('brand_id',brand_id).maybeSingle();
      if(existing){
        const { error } = await sb.from('design_systems').update({ component_html:html, updated_at:new Date().toISOString() }).eq('brand_id',brand_id);
        if(error) return json({error:error.message},400);
      } else {
        const { error } = await sb.from('design_systems').insert({ id:brand_id, brand_id, component_html:html });
        if(error) return json({error:error.message},400);
      }
      return json({ ok:true, len:html.length });
    }

    if(op==='upload'){
      const { brand_id, kind, label, filename, content_base64, higgsfield_media_id, notes } = body;
      if(!brand_id || !content_base64 || !filename) return json({error:'brand_id, filename, content_base64 required'},400);
      const ext=(filename.split('.').pop()||'png').toLowerCase();
      const bytes=Uint8Array.from(atob(content_base64), c=>c.charCodeAt(0));
      const path=`${brand_id}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await sb.storage.from(BUCKET).upload(path, bytes, { contentType: CT[ext]||'application/octet-stream', upsert:true });
      if(upErr) return json({error:'upload failed: '+upErr.message},400);
      const url = sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
      const { data, error } = await sb.from('brand_assets').insert({ brand_id, kind:kind||'other', label:label||filename, storage_path:path, url, higgsfield_media_id:higgsfield_media_id||null, notes:notes||null }).select().single();
      if(error) return json({error:error.message},400);
      return json({ ok:true, asset:data });
    }

    if(op==='update'){
      const { id } = body; if(!id) return json({error:'id required'},400);
      const patch={}; for(const k of ['kind','label','higgsfield_media_id','notes']){ if(k in body) patch[k]=body[k]; }
      const { data, error } = await sb.from('brand_assets').update(patch).eq('id',id).select().single();
      if(error) return json({error:error.message},400);
      return json({ ok:true, asset:data });
    }

    if(op==='delete'){
      const { id } = body; if(!id) return json({error:'id required'},400);
      const { data: row } = await sb.from('brand_assets').select('storage_path').eq('id',id).maybeSingle();
      if(row?.storage_path){ try{ await sb.storage.from(BUCKET).remove([row.storage_path]); }catch(_){} }
      const { error } = await sb.from('brand_assets').delete().eq('id',id);
      if(error) return json({error:error.message},400);
      return json({ ok:true });
    }

    return json({error:'unknown op: '+op},400);
  }catch(e){ return json({error:String((e as any)?.message ?? e)},500); }
});
