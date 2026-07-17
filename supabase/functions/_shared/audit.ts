// Best-effort audit logging for provider calls. Never throws — a logging
// failure must not break a booking. Rows land in public.audit_log.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export async function audit(
  db: SupabaseClient,
  sessionId: string | null,
  provider: string | null,
  action: string,
  request: unknown,
  response: unknown,
  ok: boolean,
): Promise<void> {
  try {
    await db.from("audit_log").insert({
      session_id: sessionId,
      provider: provider === "servicetitan" || provider === "ghl" || provider === "fieldroutes" ? provider : null,
      action,
      request: request ?? null,
      response: response ?? null,
      ok,
    });
  } catch (_) { /* best effort */ }
}
