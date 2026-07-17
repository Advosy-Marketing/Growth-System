// nano-banana: generate ad-creative images via Google Gemini 3 Pro Image ("Nano Banana Pro"), server-side.
// verify_jwt=false; admin/manager only (verify_pin). Auth to Google: header x-goog-api-key from vault GEMINI_API_KEY.
// Body: { actor_id, pin, op?, prompt, aspect_ratio?, resolution?, creative_id?, brand_id?, reference_urls?, use_brand_kit? }
// Flow: build brand-aware prompt + attach brand-kit reference images -> Gemini -> decode inline image
//       -> upload to public 'creatives' bucket -> return { ok, url }. Also writes back to ad_creatives when creative_id given.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'};
const json=(b,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{...cors,'Content-Type':'application/json'}});
const sb=createClient(Deno.env.get('SUPABASE_URL'),Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false}});
const MODEL='gemini-3-pro-image-preview'; // "Nano Banana Pro"
const GEN_URL='https://generativelanguage.googleapis.com/v1beta/models/'+MODEL+':generateContent';
const ARS=['1:1','3:2','2:3','3:4','4:3','4:5','5:4','9:16','16:9','21:9'];

async function getKey(){
  try{ const {data}=await sb.rpc('get_secret',{p_name:'GEMINI_API_KEY'}); if(data) return String(data); }catch(_){}
  return Deno.env.get('GEMINI_API_KEY')||'';
}
function toB64(bytes){ let bin=''; const chunk=0x8000; for(let i=0;i<bytes.length;i+=chunk){ bin+=String.fromCharCode.apply(null, bytes.subarray(i,i+chunk)); } return btoa(bin); }
async function toInline(url){
  try{
    const r=await fetch(url); if(!r.ok) return null;
    const ct=(r.headers.get('content-type')||'image/png').split(';')[0];
    if(!ct.startsWith('image/')) return null;
    const bytes=new Uint8Array(await r.arrayBuffer());
    if(!bytes.length || bytes.length>7000000) return null; // skip empty / oversized refs
    return { inlineData:{ mimeType:ct, data:toB64(bytes) } };
  }catch(_){ return null; }
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

  const key=await getKey();
  if(op==='ping') return json({ ok:true, has_key:!!key, key_len:(key||'').length, model:MODEL });
  if(!key) return json({ ok:false, error:'GEMINI_API_KEY not set in vault' },400);
  if(!prompt) return json({ error:'prompt required' },400);

  try{
    // Resolve the brand (for brief + reference kit): explicit brand_id, or walk creative -> offer -> campaign -> brand.
    let brandId = body.brand_id || null;
    if(!brandId && body.creative_id){
      const { data: cr } = await sb.from('ad_creatives').select('offer_id').eq('id',body.creative_id).maybeSingle();
      const { data: off } = cr ? await sb.from('offers').select('campaign_id').eq('id',cr.offer_id).maybeSingle() : { data:null };
      const { data: camp } = off ? await sb.from('campaigns').select('brand_id').eq('id',off.campaign_id).maybeSingle() : { data:null };
      if(camp) brandId = camp.brand_id;
    }
    let brand=null;
    if(brandId){ const { data:b } = await sb.from('brands').select('name, creative_brief').eq('id',brandId).maybeSingle(); brand=b; }

    // Build the brand-aware prompt.
    let fullPrompt = prompt;
    if(brand && brand.creative_brief){
      fullPrompt = `BRAND CREATIVE BRIEF — ${brand.name}. Follow EXACTLY (colors, style, uniform, tone):\n${brand.creative_brief}\n\nGENERATE THIS AD CREATIVE: ${prompt}\n\nUse the exact brand colors from the brief. The attached reference images show the OFFICIAL logo, technician uniform, and vehicle wrap — reproduce them faithfully (correct logo, correct uniform colors, correct truck). Photoreal, professional advertising quality, realistic Arizona setting. Any headline text must be spelled correctly and rendered cleanly.`;
    }

    // Gather reference images: brand-kit assets (default on) + any explicit reference_urls. Cap at 10.
    const refUrls=[];
    if(body.use_brand_kit!==false && brandId){
      const { data: assets } = await sb.from('brand_assets').select('url, kind')
        .eq('brand_id',brandId).in('kind',['logo','uniform','vehicle_wrap','photo','icon']).limit(8);
      for(const a of (assets||[])) if(a.url) refUrls.push(a.url);
    }
    for(const u of (body.reference_urls||[])) if(u) refUrls.push(u);
    const inlineParts=[];
    for(const u of refUrls.slice(0,10)){ const inl=await toInline(u); if(inl) inlineParts.push(inl); }

    const aspect = ARS.includes(body.aspect_ratio) ? body.aspect_ratio : '1:1';
    const resolution = ['1K','2K','4K'].includes(String(body.resolution||'').toUpperCase()) ? String(body.resolution).toUpperCase() : '2K';

    const reqBody={
      contents:[{ parts:[ ...inlineParts, { text: fullPrompt } ] }],
      generationConfig:{ responseModalities:['IMAGE'], imageConfig:{ aspectRatio:aspect, imageSize:resolution } },
    };

    const r=await fetch(GEN_URL,{ method:'POST', headers:{ 'x-goog-api-key':key, 'Content-Type':'application/json' }, body:JSON.stringify(reqBody) });
    const t=await r.text(); let j; try{ j=JSON.parse(t); }catch{ j={ _raw:t.slice(0,600) }; }
    if(!r.ok){
      if(body.creative_id){ try{ await sb.from('ad_creatives').update({ image_status:'error' }).eq('id',body.creative_id); }catch(_){} }
      return json({ ok:false, stage:'generate', http:r.status, error:(j.error&&j.error.message)||j._raw||('HTTP '+r.status) });
    }

    const cand = j.candidates && j.candidates[0];
    const outParts = (cand && cand.content && cand.content.parts) || [];
    const imgPart = outParts.find(p=>p.inlineData && p.inlineData.data);
    if(!imgPart){
      return json({ ok:false, stage:'no_image', finishReason:(cand&&cand.finishReason)||null, promptFeedback:j.promptFeedback||null, note:'model returned no image (possibly safety-blocked or text-only)' });
    }

    const mime = imgPart.inlineData.mimeType || 'image/png';
    const ext = mime.includes('jpeg') ? 'jpg' : (mime.includes('webp') ? 'webp' : 'png');
    const bytes = Uint8Array.from(atob(imgPart.inlineData.data), c=>c.charCodeAt(0));
    const path = `${brandId||'general'}/${crypto.randomUUID()}.${ext}`;
    const { error: upErr } = await sb.storage.from('creatives').upload(path, bytes, { contentType:mime, upsert:true });
    if(upErr) return json({ ok:false, stage:'store', error:upErr.message });
    const url = sb.storage.from('creatives').getPublicUrl(path).data.publicUrl;

    if(body.creative_id){ try{ await sb.from('ad_creatives').update({ asset_ref:url, image_status:'done', updated_at:new Date().toISOString() }).eq('id',body.creative_id); }catch(_){} }
    return json({ ok:true, url, model:MODEL, resolution, aspect_ratio:aspect, references_used:inlineParts.length });
  }catch(e){ return json({ ok:false, error:String((e as any)?.message ?? e) },500); }
});
