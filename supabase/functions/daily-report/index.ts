// daily-report: end-of-day team breakdown emailed via Resend. verify_jwt=false (cron-triggered).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const sb = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
async function secret(name, fallback){ const e=Deno.env.get(name); if(e) return e; try{ const {data}=await sb.rpc('get_secret',{p_name:name}); if(data) return String(data);}catch(_){} return fallback; }
const money=n=>'$'+Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});

Deno.serve(async (req)=>{
  const want=Deno.env.get('CRON_SECRET');
  if(want){ if(req.headers.get('x-cron-secret')!==want) return new Response('forbidden',{status:403}); }
  const nowMs=Date.now();
  const az=new Date(nowMs-7*3600000); // Arizona = UTC-7, no DST
  const startMs=Date.UTC(az.getUTCFullYear(),az.getUTCMonth(),az.getUTCDate(),0,0,0)+7*3600000;
  const start=new Date(startMs).toISOString(), end=new Date(nowMs).toISOString();
  const [uRes,eRes,cRes]=await Promise.all([
    sb.from('app_users').select('id,full_name,team,hourly_rate').eq('is_active',true),
    sb.from('time_entries').select('user_id,clock_in,clock_out').gte('clock_in',new Date(startMs-14*86400000).toISOString()),
    sb.from('commissions').select('amount,user_id,created_at').gte('created_at',start).lt('created_at',end),
  ]);
  const users=uRes.data||[], entries=eRes.data||[], comms=cRes.data||[];
  const rows=users.map(u=>{
    let ms=0; for(const e of entries){ if(e.user_id!==u.id) continue; const a=new Date(e.clock_in).getTime(); const b=e.clock_out?new Date(e.clock_out).getTime():nowMs; ms+=Math.max(0,Math.min(b,nowMs)-Math.max(a,startMs)); }
    const myc=comms.filter(c=>c.user_id===u.id);
    const rate=Number(u.hourly_rate||0); const hours=ms/3600000; const commission=myc.reduce((s,c)=>s+Number(c.amount),0);
    return { name:u.full_name, team:u.team, hours, appts:myc.length, commission, total: hours*rate+commission };
  }).filter(r=>r.hours>0||r.appts>0||r.commission>0).sort((a,b)=>b.commission-a.commission);
  const tot=rows.reduce((a,r)=>({hours:a.hours+r.hours,appts:a.appts+r.appts,commission:a.commission+r.commission,total:a.total+r.total}),{hours:0,appts:0,commission:0,total:0});
  const dayLabel=new Date(startMs).toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric',timeZone:'America/Phoenix'});
  const tr=rows.map(r=>`<tr><td style=\"padding:7px 10px;border-bottom:1px solid #eee\">${r.name}</td><td style=\"padding:7px 10px;border-bottom:1px solid #eee;text-transform:uppercase;font-size:11px;color:#888\">${r.team||''}</td><td align=\"right\" style=\"padding:7px 10px;border-bottom:1px solid #eee\">${r.hours.toFixed(2)}h</td><td align=\"right\" style=\"padding:7px 10px;border-bottom:1px solid #eee\">${r.appts}</td><td align=\"right\" style=\"padding:7px 10px;border-bottom:1px solid #eee;color:#16834a;font-weight:600\">${money(r.commission)}</td></tr>`).join('');
  const html=`<div style=\"font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:auto;color:#1a2230\"><h2 style=\"color:#8b5cf6;margin:0 0 2px\">Advosy Growth — Daily Report</h2><div style=\"color:#888;font-size:13px;margin-bottom:16px\">${dayLabel}</div><table style=\"width:100%;border-collapse:collapse;font-size:14px\"><thead><tr style=\"background:#f4f4f5;text-align:left;font-size:11px;text-transform:uppercase;color:#888\"><th style=\"padding:8px 10px\">Rep</th><th style=\"padding:8px 10px\">Team</th><th align=\"right\" style=\"padding:8px 10px\">Hours</th><th align=\"right\" style=\"padding:8px 10px\">Appts</th><th align=\"right\" style=\"padding:8px 10px\">Commission</th></tr></thead><tbody>${tr||'<tr><td colspan=\"5\" style=\"padding:14px 10px;color:#888\">No activity logged today.</td></tr>'}</tbody><tfoot><tr style=\"font-weight:bold;border-top:2px solid #ddd\"><td style=\"padding:9px 10px\" colspan=\"2\">Team total</td><td align=\"right\" style=\"padding:9px 10px\">${tot.hours.toFixed(2)}h</td><td align=\"right\" style=\"padding:9px 10px\">${tot.appts}</td><td align=\"right\" style=\"padding:9px 10px;color:#16834a\">${money(tot.commission)}</td></tr></tfoot></table><p style=\"color:#999;font-size:12px;margin-top:18px\">Open the Payroll &amp; Reports console for full hours, hourly pay, and commission detail by customer.</p></div>`;
  const key=await secret('RESEND_API_KEY','');
  const from=await secret('MAIL_FROM','Advosy Growth <onboarding@resend.dev>');
  const to=await secret('MAIL_TO','chandler@advosy.com');
  if(!key){ return new Response(JSON.stringify({ok:false,sent:false,reason:'RESEND_API_KEY not set yet',rows:rows.length,day:dayLabel}),{headers:{'Content-Type':'application/json'}}); }
  const rs=await fetch('https://api.resend.com/emails',{method:'POST',headers:{'Authorization':'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({from,to:[to],subject:'Advosy Growth — Daily Report ('+dayLabel+')',html})});
  const rj=await rs.json().catch(()=>({}));
  return new Response(JSON.stringify({ok:rs.ok,sent:rs.ok,to,resend:rj}),{status:rs.ok?200:500,headers:{'Content-Type':'application/json'}});
});
