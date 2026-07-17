// campaign-ai: server-side generation for the sequential campaign builder.
// Ops: gen_offer (SB7 offer) · gen_landing (on-brand HTML) · gen_creatives (ad concepts) · gen_scripts (rep scripts + attribution).
// Uses Claude (ANTHROPIC_API_KEY). verify_jwt=false; admin/manager only (verify_pin).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'};
const json=(b,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{...cors,'Content-Type':'application/json'}});
const sb=createClient(Deno.env.get('SUPABASE_URL'),Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false}});
async function secret(name){ const e=Deno.env.get(name); if(e) return e; try{const {data}=await sb.rpc('get_secret',{p_name:name}); if(data) return String(data);}catch(_){} return ''; }

async function claude(system, user, max_tokens=3000){
  const key=await secret('ANTHROPIC_API_KEY');
  if(!key) throw new Error('ANTHROPIC_API_KEY not set');
  const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',
    headers:{'x-api-key':key,'anthropic-version':'2023-06-01','content-type':'application/json'},
    body:JSON.stringify({model:'claude-sonnet-5',max_tokens,system,messages:[{role:'user',content:user}]})});
  const j=await r.json(); if(!r.ok) throw new Error((j.error&&j.error.message)||('anthropic '+r.status));
  return (Array.isArray(j.content)?j.content.map((c)=>c&&c.text||'').join(''):'')||'';
}
function parseJson(t){
  let s=String(t||'').trim();
  const fence=s.match(/```(?:json)?\s*([\s\S]*?)```/i); if(fence) s=fence[1].trim();
  const a=s.search(/[[{]/); const b=Math.max(s.lastIndexOf('}'),s.lastIndexOf(']'));
  if(a>=0 && b>a) s=s.slice(a,b+1);
  return JSON.parse(s);
}
function stripFences(t){ let s=String(t||'').trim(); const f=s.match(/```(?:html)?\s*([\s\S]*?)```/i); if(f) s=f[1].trim(); return s; }

async function bundle(campaign_id, offer_id){
  const { data: camp } = await sb.from('campaigns').select('*').eq('id',campaign_id).maybeSingle();
  if(!camp) return null;
  const [{ data: brand }, { data: ds }, { data: offers }] = await Promise.all([
    sb.from('brands').select('*').eq('id',camp.brand_id).maybeSingle(),
    sb.from('design_systems').select('*').eq('brand_id',camp.brand_id).maybeSingle(),
    sb.from('offers').select('*').eq('campaign_id',campaign_id),
  ]);
  let offer=null;
  if(offer_id) offer=(offers||[]).find((o)=>o.id===offer_id)||null;
  if(!offer) offer=(offers||[])[0]||null;
  return { camp, brand:brand||{}, ds:ds||{}, offers:offers||[], offer };
}
function brandCtx(b, ds){
  return `Brand: ${b.name} (${b.vertical||''}). Market: ${b.market||''}. Website: ${b.live_site||''}.
Proof points: ${(b.standing_proof_points||[]).join('; ')||'—'}.
Design DNA: ${(ds&&ds.design_dna)||'—'}.
Color tokens: ${JSON.stringify((ds&&ds.color_tokens)||{})}.
Typography: ${JSON.stringify((ds&&ds.typography)||{})}.`;
}
function offerCtx(o){
  if(!o) return 'No offer approved yet.';
  return `Offer: ${o.name}. For: ${o.avatar||''}. Angle: ${o.angle_family||''}.
Pricing: ${o.pricing||''}. Why it matters: ${o.why||''}.
Value stack: ${JSON.stringify(o.value_stack||[])}.
Direct CTA: ${o.cta_direct||''} | Transitional CTA: ${o.cta_transitional||''}.
BrandScript: ${JSON.stringify(o.brandscript||{})}.`;
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
    const p=payload||{};

    // STEP 2 — StoryBrand SB7 offer from the goal + brand.
    if(op==='gen_offer'){
      const b=await bundle(p.campaign_id); if(!b) return json({error:'campaign not found'},404);
      const system=`You are an elite direct-response offer strategist for home-services brands, fluent in StoryBrand SB7. Return STRICT JSON only — no prose, no code fences.`;
      const user=`${brandCtx(b.brand,b.ds)}

Campaign goal: ${b.camp.goal||b.camp.objective||'(not set)'}
${p.notes?('Extra direction: '+p.notes):''}

Design ONE compelling offer. Return JSON with EXACTLY these keys:
{"name":string,"avatar":string,"angle_family":string,"value_stack":[{"label":string,"value_usd":number|null,"partner_brand":string|null}],"pricing":string,"why":string,"cta_direct":string,"cta_transitional":string,"brandscript":{"hero":string,"problem":{"external":string,"internal":string,"philosophical":string},"guide":{"empathy":string,"authority":string},"plan":string,"cta":string,"success":string,"failure":string}}`;
      const raw=await claude(system,user,3200);
      let draft; try{ draft=parseJson(raw); }catch(e){ return json({ ok:false, error:'parse_failed', raw:raw.slice(0,1200) }); }
      return json({ ok:true, draft });
    }

    // STEP 3 — a complete, on-brand landing page (single self-contained HTML file).
    // When the brand has an uploaded component library (design_systems.component_html), the page is
    // assembled STRICTLY from those real sections/classes/colors + the real logo — no inventing.
    if(op==='gen_landing'){
      const b=await bundle(p.campaign_id, p.offer_id); if(!b) return json({error:'campaign not found'},404);
      if(!b.offer) return json({error:'approve an offer first (Step 2)'},400);
      const pixel=b.brand.fb_pixel_id||'';
      const lib=(b.ds&&b.ds.component_html)||'';
      let logoUrl='';
      try{ const { data:logos }=await sb.from('brand_assets').select('url,kind').eq('brand_id',b.camp.brand_id).in('kind',['logo','icon']);
        if(logos&&logos.length){ logoUrl=((logos.find((l)=>/logo/i.test(l.kind))||logos[0]).url)||''; } }catch(_){}

      let system, user, maxTok;
      if(lib){
        maxTok=11000;
        system=`You are a senior front-end engineer who builds landing pages by REUSING a brand's existing component library — you never invent a new look. You are given the brand's real, pixel-matched styleguide/component HTML. Reuse its EXACT Tailwind config, <style> CSS, color classes, fonts, and section markup. Compose the real sections into a complete, self-contained, responsive landing page for the given offer and swap in the offer copy. Output ONLY raw HTML (one file) — no explanation, no markdown fences.`;
        user=`BRAND COMPONENT LIBRARY / STYLEGUIDE — reuse these EXACT tokens, classes, and section blocks. Do NOT invent new styles, colors, or fonts:
<<<COMPONENT_LIBRARY
${lib}
COMPONENT_LIBRARY

${brandCtx(b.brand,b.ds)}
${logoUrl?('Official logo image URL — use it as an <img> in the header/nav AND footer (not text): '+logoUrl):'No logo image uploaded — use the brand wordmark styled per the library.'}

${offerCtx(b.offer)}

Assemble a high-converting landing page for THIS offer using ONLY the component library above:
- Copy the library's Tailwind config <script> and its <style> block into <head> VERBATIM so classes render identically.
- Reuse the library's real header/nav, hero, value/feature sections, CTA bands, testimonial/proof, and footer. Compose them into a full page and swap in this offer's copy: headline from the hook, subhead, the value stack as the "what you get" list with dollar values, 3 proof points, a short FAQ.
- Use the official logo image (above) in the header and footer.
- Lead form: <form data-ghl-endpoint="REPLACE_WITH_GHL_WEBHOOK" onsubmit="return false;"> with First name, Phone, Email, and a submit button styled with the library's PRIMARY button classes.
- Meta Pixel base snippet in <head> using pixel id ${pixel||'REPLACE_PIXEL_ID'}; fire a 'Lead' event on submit.
- Output a COMPLETE, valid single HTML file — every tag closed. It must look like it came from the same designer as the component library.`;
      } else {
        maxTok=6000;
        system=`You are a senior conversion copywriter and front-end engineer. You output a COMPLETE, self-contained, responsive HTML landing page in ONE file that visually matches the brand's design system (use its exact color tokens and font). Use inline <style> (no external CSS besides optional Google Fonts). Output ONLY raw HTML — no explanation, no markdown fences.`;
        user=`${brandCtx(b.brand,b.ds)}
${logoUrl?('Official logo image URL (use as an <img> in the header): '+logoUrl):''}

${offerCtx(b.offer)}

Build a high-converting landing page for this offer. Requirements:
- Match the brand colors/fonts exactly. Clean, modern, mobile-first.
- Sections: sticky header w/ logo + CTA; hero (headline from the offer's hook + subhead + primary CTA); the value stack as a clear "what you get" list with dollar values; 3 trust/proof points; a simple lead form (First name, Phone, Email) with a prominent submit button; a short FAQ; footer.
- The form tag: <form data-ghl-endpoint="REPLACE_WITH_GHL_WEBHOOK" onsubmit="return false;"> (a developer wires the endpoint later).
- Include a Meta Pixel base snippet in <head> using pixel id ${pixel||'REPLACE_PIXEL_ID'} and fire a 'Lead' event on submit.
- Be CONCISE: a tight, single-file page (~140-200 lines). Complete and valid — every tag closed.`;
      }
      const html=stripFences(await claude(system,user,maxTok));
      return json({ ok:true, html, used_library:!!lib, used_logo:!!logoUrl });
    }

    // STEP 4 — a batch of ad creative concepts (text).
    if(op==='gen_creatives'){
      const b=await bundle(p.campaign_id, p.offer_id); if(!b) return json({error:'campaign not found'},404);
      const count=Math.min(Math.max(Number(p.count)||3,1),6);
      const system=`You are a performance creative director for Meta ads in home services. Return STRICT JSON only — an array, no prose, no code fences.`;
      const user=`${brandCtx(b.brand,b.ds)}

${offerCtx(b.offer)}

Generate ${count} distinct Facebook/Instagram ad creative concepts for this offer. Return a JSON array of ${count} objects with EXACTLY these keys:
[{"hook":string,"headline":string,"primary_text":string,"description":string,"visual_direction":string,"cta":string}]
- hook: the scroll-stopping first line.
- primary_text: the ad body (2-4 short lines, benefit-led, StoryBrand voice).
- headline: <=40 chars. description: <=30 chars.
- visual_direction: a concrete image prompt/direction for the creative team (what's shown).
- cta: one of LEARN_MORE, BOOK_NOW, GET_OFFER, SIGN_UP, GET_QUOTE.`;
      const raw=await claude(system,user,3000);
      let concepts; try{ concepts=parseJson(raw); }catch(e){ return json({ ok:false, error:'parse_failed', raw:raw.slice(0,1200) }); }
      if(!Array.isArray(concepts)) concepts=[concepts];
      return json({ ok:true, concepts });
    }

    // STEP 5 — rep scripts + CRM campaign tags/attribution.
    if(op==='gen_scripts'){
      const b=await bundle(p.campaign_id, p.offer_id); if(!b) return json({error:'campaign not found'},404);
      const slug=(b.camp.id||'campaign');
      const system=`You are a sales enablement lead for a home-services company. Write simple, spoken-word rep scripts a normal person can deliver, and clean CRM attribution tags. Return STRICT JSON only.`;
      const user=`${brandCtx(b.brand,b.ds)}

${offerCtx(b.offer)}
Campaign goal: ${b.camp.goal||b.camp.objective||''}
Campaign id (for tag base): ${slug}

Return JSON with EXACTLY these keys:
{
 "scripts":[
   {"role":"Outbound Reps","script":string},
   {"role":"Inbound Reps","script":string},
   {"role":"Technicians","script":string}
 ],
 "attribution":{"crm_tag":string,"lead_source":string,"utm_campaign":string,"utm_source":string,"utm_medium":string,"notes":string}
}
- Each script: 4-7 short sentences — how the customer moves forward, exactly what they get (from the value stack), and how it helps them. Continuity with the offer + ad messaging. No fluff.
- Attribution: consistent, lowercase-hyphen tags reps set in the CRM so closed leads trace back to THIS campaign. utm_source "facebook", utm_medium "paid-social" unless the goal implies otherwise.`;
      const raw=await claude(system,user,2600);
      let out; try{ out=parseJson(raw); }catch(e){ return json({ ok:false, error:'parse_failed', raw:raw.slice(0,1200) }); }
      return json({ ok:true, ...out });
    }

    return json({error:'unknown op: '+op},400);
  }catch(e){ return json({error:String((e as any)?.message ?? e)},500); }
});
