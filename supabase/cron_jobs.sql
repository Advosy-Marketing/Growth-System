-- ============================================================================
-- Advosy Growth - pg_cron jobs export
-- Source project: andzztvmaleiefxcfjwh | Exported: 2026-07-17
-- 7 active jobs (jobids 1,2,3,4,6,7,8 in source; jobid 5 no longer exists).
--
-- BEFORE APPLYING TO A NEW PROJECT:
--   1. Replace every "andzztvmaleiefxcfjwh.supabase.co" URL with the NEW
--      project's functions URL.
--   2. Jobs 3 and 4 (ghl-calls) hard-code the OLD project's anon JWT in the
--      Authorization header - replace with the new project's anon key.
--   3. Jobs 5-7 (ai-setter) read the AI_WEBHOOK_TOKEN secret from Vault -
--      create that secret in the new project's Vault first.
-- ============================================================================

-- 1. advosy-daily-report: daily 4:00 AM UTC - fires the daily-report edge
--    function (Slack/email daily growth report).
select cron.schedule('advosy-daily-report', '0 4 * * *', $$
  select net.http_post(
    url := 'https://andzztvmaleiefxcfjwh.supabase.co/functions/v1/daily-report',
    headers := jsonb_build_object('Content-Type','application/json'),
    body := jsonb_build_object('source','cron')
  );
$$);

-- 2. marketing-cache-warm: every 20 min - refreshes the marketing dashboard
--    cache for last_7d / last_30d / last_90d presets.
select cron.schedule('marketing-cache-warm', '*/20 * * * *', $$
  select net.http_post(url:='https://andzztvmaleiefxcfjwh.supabase.co/functions/v1/marketing', headers:=jsonb_build_object('Content-Type','application/json'), body:=jsonb_build_object('refresh',true,'date_preset','last_7d'), timeout_milliseconds:=2000);
  select net.http_post(url:='https://andzztvmaleiefxcfjwh.supabase.co/functions/v1/marketing', headers:=jsonb_build_object('Content-Type','application/json'), body:=jsonb_build_object('refresh',true,'date_preset','last_30d'), timeout_milliseconds:=2000);
  select net.http_post(url:='https://andzztvmaleiefxcfjwh.supabase.co/functions/v1/marketing', headers:=jsonb_build_object('Content-Type','application/json'), body:=jsonb_build_object('refresh',true,'date_preset','last_90d'), timeout_milliseconds:=2000);
$$);

-- 3. ghl-calls-recent: every 10 min - syncs recent GHL call records into
--    ghl_calls. NOTE: Bearer token below is the OLD project's anon key;
--    replace it for the new project.
select cron.schedule('ghl-calls-recent', '*/10 * * * *', $$
  select net.http_post(
    url:='https://andzztvmaleiefxcfjwh.supabase.co/functions/v1/ghl-calls-sync',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer REPLACE_WITH_NEW_PROJECT_ANON_KEY'),
    body:='{"mode":"recent","budgetMs":55000}'::jsonb);
$$);

-- 4. ghl-calls-backfill: every 2 min - backfills historical GHL calls,
--    3 pages per run. Same anon-key note as job 3.
select cron.schedule('ghl-calls-backfill', '*/2 * * * *', $$
  select net.http_post(
    url:='https://andzztvmaleiefxcfjwh.supabase.co/functions/v1/ghl-calls-sync',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer REPLACE_WITH_NEW_PROJECT_ANON_KEY'),
    body:='{"mode":"backfill","pages":3,"budgetMs":55000}'::jsonb);
$$);

-- 5. ai-setter-tick: every minute - AI setter heartbeat (due replies, SLA,
--    nurture steps). Auth via X-AI-Token pulled from Vault.
select cron.schedule('ai-setter-tick', '* * * * *', $$
  select net.http_post(
    url := 'https://andzztvmaleiefxcfjwh.supabase.co/functions/v1/ai-setter/tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-AI-Token', (select decrypted_secret from vault.decrypted_secrets where name = 'AI_WEBHOOK_TOKEN')
    ),
    body := '{}'::jsonb
  );
$$);

-- 6. ai-setter-digest: daily 14:00 UTC (7 AM Phoenix) - AI setter daily digest.
select cron.schedule('ai-setter-digest', '0 14 * * *', $$
  select net.http_post(
    url := 'https://andzztvmaleiefxcfjwh.supabase.co/functions/v1/ai-setter/digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-AI-Token', (select decrypted_secret from vault.decrypted_secrets where name = 'AI_WEBHOOK_TOKEN')
    ),
    body := '{}'::jsonb
  );
$$);

-- 7. ai-setter-fr-sync: hourly at :20 - FieldRoutes customer sync for the
--    AI setter (fr_customer_sync table).
select cron.schedule('ai-setter-fr-sync', '20 * * * *', $$
  select net.http_post(
    url := 'https://andzztvmaleiefxcfjwh.supabase.co/functions/v1/ai-setter/fr-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-AI-Token', (select decrypted_secret from vault.decrypted_secrets where name = 'AI_WEBHOOK_TOKEN')
    ),
    body := '{}'::jsonb
  );
$$);
