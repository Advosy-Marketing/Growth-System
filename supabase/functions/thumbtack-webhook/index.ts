// thumbtack-webhook: receives Thumbtack leads (one webhook per company) and stores them.
// URL: /functions/v1/thumbtack-webhook?company=<slug>&token=<token>
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const sb=createClient(Deno.env.get('SUPABASE_URL'),Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false}});
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, content-type, x-webhook-token','Access-Control-Allow-Methods':'POST, GET, OPTIONS'};
async function secret(name){ const e=Deno.env.get(name); if(e) return e; try{const {data}=await sb.rpc('get_secret',{p_name:name}); if(data) return String(data);}catch(_){} return ''; }
function pick(o,keys){ if(!o) return null; for(const k of keys){ if(o[k]!=null && o[k]!=='') return o[k]; } return null; }
function money(v){ if(v==null) return null; const n=Number(String(v).replace(/[^0-9.\-]/g,'')); return isFinite(n)?n:null; }
function parseTs(v){ if(v==null) return null; if(typeof v==='number'||/^\d+$/.test(String(v))){ let n=Number(v); if(n<1e12) n*=1000; const d=new Date(n); return isNaN(+d)?null:d.toISOString(); } const d=new Date(v); return isNaN(+d)?null:d.toISOString(); }

Deno.serve(async (req)=>{
  if(req.method==='OPTIONS') return new Response('ok',{headers:cors});
  const url=new URL(req.url);
  if(req.method==='GET'){ const ch=url.searchParams.get('challenge'); return new Response(ch||'thumbtack-webhook ok',{status:200,headers:cors}); }
  if(req.method!=='POST') return new Response('POST only',{status:405,headers:cors});
  const want=await secret('THUMBTACK_WEBHOOK_TOKEN');
  const token=url.searchParams.get('token')||req.headers.get('x-webhook-token')||'';
  if(want && token!==want) return new Response('forbidden',{status:403,headers:cors});
  const company=url.searchParams.get('company');
  let body; try{ body=await req.json(); }catch{ body={}; }
  const L = body.lead || body.data || body.contact || body;
  const lead_id = pick(L,['leadID','leadId','lead_id','id','contact_id','negotiationID','negotiationId']);
  const name = pick(L,['customerName','customer_name','name','full_name','fullName','customer']) || pick(body,['name','full_name','customer_name']);
  const phone = pick(L,['phone','phoneNumber','customerPhone','phone_number']);
  const price = money(pick(L,['price','cost','leadCost','lead_cost','amount','spend','charge','leadPrice']) ?? pick(body,['price','cost','lead_cost','amount']));
  const category = pick(L,['category','serviceCategory','service','service_category','requestCategory','title']);
  const lead_type = pick(L,['leadType','lead_type','type']);
  const created = parseTs(pick(L,['createTimestamp','created','createdAt','created_at','timestamp','dateCreated']));
  const comp = company || pick(L,['company','business','companyName','profile','businessName','company_profile']);
  const row = { lead_id: lead_id?String(lead_id):null, company:comp, service_category:category?String(category):null, customer_name:name?String(name):null, phone:phone?String(phone):null, price, lead_type:lead_type?String(lead_type):null, lead_created:created, raw:body };
  try{
    if(row.lead_id){ await sb.from('thumbtack_leads').upsert(row,{onConflict:'lead_id'}); }
    else { await sb.from('thumbtack_leads').insert(row); }
  }catch(e){ return new Response(JSON.stringify({ok:false,error:String(e?.message??e)}),{status:500,headers:{...cors,'Content-Type':'application/json'}}); }
  return new Response(JSON.stringify({ok:true,company:comp,price:row.price,lead_id:row.lead_id}),{status:200,headers:{...cors,'Content-Type':'application/json'}});
});
