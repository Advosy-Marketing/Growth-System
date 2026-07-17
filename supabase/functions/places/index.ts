// places: Google Places proxy for the booking app address search. verify_jwt=false.
// Keeps the API key server-side (env GOOGLE_PLACES_KEY, else Supabase Vault get_secret).
// Body: { op:'autocomplete', input } | { op:'details', place_id }
// Restricts to US + Arizona/Nevada. Returns structured components for ServiceTitan/GHL.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth:{persistSession:false} });
const cors = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS' };
const json = (b,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{...cors,'Content-Type':'application/json'}});

async function secret(name){ const e=Deno.env.get(name); if(e) return e; try{ const { data } = await sb.rpc('get_secret',{p_name:name}); if(data) return String(data); }catch(_){} return ''; }

const RECT = { low:{ latitude:31.2, longitude:-120.3 }, high:{ latitude:42.2, longitude:-108.8 } };
const AZNV_RE = /,\s*(AZ|Arizona|NV|Nevada)\b/i;

async function autoNew(key,input){
  const r = await fetch('https://places.googleapis.com/v1/places:autocomplete',{
    method:'POST', headers:{ 'Content-Type':'application/json', 'X-Goog-Api-Key':key },
    body: JSON.stringify({ input, includedRegionCodes:['us'], locationBias:{ rectangle:RECT } }),
  });
  const b = await r.json().catch(()=>({}));
  if(!r.ok) return { ok:false, status:r.status, body:b };
  const out=[];
  for(const s of (b.suggestions||[])){ const p=s.placePrediction; if(!p) continue; const desc=(p.text&&p.text.text)||''; if(desc && AZNV_RE.test(desc)) out.push({ placeId:p.placeId, description:desc }); }
  return { ok:true, predictions: out.slice(0,8) };
}
async function detailsNew(key,placeId){
  const r = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,{
    headers:{ 'X-Goog-Api-Key':key, 'X-Goog-FieldMask':'formattedAddress,addressComponents,location' },
  });
  const b = await r.json().catch(()=>({}));
  if(!r.ok) return { ok:false, status:r.status, body:b };
  const comp={};
  for(const c of (b.addressComponents||[])){ for(const t of (c.types||[])){ comp[t]=c.longText; if(t==='administrative_area_level_1'||t==='postal_code') comp[t+'_short']=c.shortText; } }
  return { ok:true, ...assemble(comp, b.formattedAddress, b.location&&b.location.latitude, b.location&&b.location.longitude) };
}
async function autoLegacy(key,input){
  const u = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&components=country:us&location=35.5,-113&radius=600000&key=${key}`;
  const r = await fetch(u); const b = await r.json().catch(()=>({}));
  if(b.status && b.status!=='OK' && b.status!=='ZERO_RESULTS') return { ok:false, status:b.status, body:b };
  const out=[];
  for(const p of (b.predictions||[])){ const desc=p.description||''; if(desc && AZNV_RE.test(desc)) out.push({ placeId:p.place_id, description:desc }); }
  return { ok:true, predictions: out.slice(0,8) };
}
async function detailsLegacy(key,placeId){
  const u = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=address_component,formatted_address,geometry&key=${key}`;
  const r = await fetch(u); const b = await r.json().catch(()=>({}));
  if(b.status && b.status!=='OK') return { ok:false, status:b.status, body:b };
  const res = b.result||{}; const comp={};
  for(const c of (res.address_components||[])){ for(const t of (c.types||[])){ comp[t]=c.long_name; if(t==='administrative_area_level_1'||t==='postal_code') comp[t+'_short']=c.short_name; } }
  const loc = res.geometry&&res.geometry.location;
  return { ok:true, ...assemble(comp, res.formatted_address, loc&&loc.lat, loc&&loc.lng) };
}
function assemble(comp, formattedAddress, lat, lng){
  const street = [comp['street_number'], comp['route']].filter(Boolean).join(' ');
  const city = comp['locality'] || comp['sublocality'] || comp['postal_town'] || comp['administrative_area_level_3'] || comp['neighborhood'] || '';
  const state = comp['administrative_area_level_1_short'] || comp['administrative_area_level_1'] || '';
  const zip = comp['postal_code'] || comp['postal_code_short'] || '';
  const formatted = [street, city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') || (formattedAddress||'');
  return { formatted, street, city, state, zip, lat:lat??null, lng:lng??null };
}

Deno.serve(async (req)=>{
  if(req.method==='OPTIONS') return new Response('ok',{headers:cors});
  if(req.method!=='POST') return json({error:'POST only'},405);
  let body={}; try{ body=await req.json(); }catch{ return json({error:'bad json'},400); }
  const key = await secret('GOOGLE_PLACES_KEY');
  if(!key) return json({ error:'GOOGLE_PLACES_KEY not set', predictions:[] }, 200);
  try{
    if(body.op==='autocomplete'){
      const input = String(body.input||'').trim();
      if(input.length<3) return json({ predictions:[] });
      let r = await autoNew(key, input);
      if(!r.ok) r = await autoLegacy(key, input);
      if(!r.ok) return json({ error:'autocomplete failed', detail:r, predictions:[] }, 200);
      return json({ predictions:r.predictions });
    }
    if(body.op==='details'){
      const id = String(body.place_id||'');
      if(!id) return json({ error:'place_id required' }, 400);
      let r = await detailsNew(key, id);
      if(!r.ok) r = await detailsLegacy(key, id);
      if(!r.ok) return json({ error:'details failed', detail:r }, 200);
      return json(r);
    }
    return json({ error:'unknown op' }, 400);
  }catch(e){ return json({ error:String(e?.message ?? e) }, 500); }
});
