// st-lookup: one-off helper — authenticates to ServiceTitan with the configured creds and
// returns Business Units + Job Types (id + name) so we can wire service_catalog. verify_jwt=false.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth:{persistSession:false} });
const cors = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS' };
const json = (b:unknown,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{...cors,'Content-Type':'application/json'}});

const ENV = Deno.env.get('ST_ENV') ?? 'production';
const AUTH = ENV==='integration' ? 'https://auth-integration.servicetitan.io' : 'https://auth.servicetitan.io';
const API  = ENV==='integration' ? 'https://api-integration.servicetitan.io' : 'https://api.servicetitan.io';

async function secret(name:string){ const e=Deno.env.get(name); if(e) return e; const { data } = await admin.rpc('get_secret',{p_name:name}); if(!data) throw new Error(`missing secret ${name}`); return String(data); }

Deno.serve(async (req)=>{
  if(req.method==='OPTIONS') return new Response('ok',{headers:cors});
  let reqBody:any={}; try{ reqBody = await req.json(); }catch{}
  try{
    const [clientId, clientSecret, appKey, tenantId] = await Promise.all([
      secret('ST_CLIENT_ID'), secret('ST_CLIENT_SECRET'), secret('ST_APP_KEY'), secret('ST_TENANT_ID')
    ]);
    // OAuth client-credentials
    const tr = await fetch(`${AUTH}/connect/token`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams({ grant_type:'client_credentials', client_id:clientId, client_secret:clientSecret }) });
    const tb = await tr.json().catch(()=>({}));
    if(!tr.ok) return json({ step:'auth', status:tr.status, body:tb }, 502);
    const token = tb.access_token;
    // Decode the JWT payload (NOT secret) to see what scopes/app the token actually carries.
    let tokenClaims:any = { note:'opaque token' };
    try{ const parts=String(token).split('.'); if(parts.length>=2){ let b=parts[1].replace(/-/g,'+').replace(/_/g,'/'); b+='='.repeat((4-b.length%4)%4); tokenClaims = JSON.parse(atob(b)); } }catch(e){ tokenClaims = { decodeError:String(e) }; }
    const H = { 'Authorization':`Bearer ${token}`, 'ST-App-Key':appKey, 'Accept':'application/json' };

    // Read a single booking back (to verify what we sent, e.g. the summary/notes).
    if(reqBody.booking_id){
      const pid = await secret('ST_BOOKING_PROVIDER_ID').catch(()=>null);
      const r = await fetch(`${API}/crm/v2/tenant/${tenantId}/booking-provider/${pid}/bookings/${reqBody.booking_id}`, { headers:H });
      const b = await r.json().catch(()=>({}));
      return json({ ok:r.ok, status:r.status, booking:b });
    }

    if(reqBody.campaigns){
      const out:any[]=[]; let page=1;
      for(let i=0;i<25;i++){
        const r = await fetch(`${API}/marketing/v2/tenant/${tenantId}/campaigns?page=${page}&pageSize=200&active=True`, { headers:H });
        const b = await r.json().catch(()=>({}));
        if(!r.ok) return json({ ok:false, status:r.status, error:b });
        for(const x of (b.data||[])) out.push({ id:x.id, name:x.name, category:(x.category&&x.category.name)||x.category||null, active:x.active });
        if(!b.hasMore) break; page++;
      }
      return json({ ok:true, count:out.length, campaigns:out });
    }

    async function getAll(path:string){
      const out:any[]=[]; let page=1;
      for(let i=0;i<10;i++){
        const r = await fetch(`${API}${path}?page=${page}&pageSize=200&active=true`, { headers:H });
        const b = await r.json().catch(()=>({}));
        if(!r.ok) return { error:{ path, status:r.status, body:b } };
        for(const x of (b.data||[])) out.push({ id:x.id, name:x.name, active:x.active });
        if(!b.hasMore && !(b.data && b.data.length===200)) break;
        page++;
      }
      return { data: out };
    }

    const bu = await getAll(`/settings/v2/tenant/${tenantId}/business-units`);
    const jt = await getAll(`/jpm/v2/tenant/${tenantId}/job-types`);
    return json({ ok:true, env:ENV, tokenClaims, businessUnits: bu, jobTypes: jt });
  }catch(e){ return json({ error:String((e as any)?.message ?? e) }, 500); }
});
