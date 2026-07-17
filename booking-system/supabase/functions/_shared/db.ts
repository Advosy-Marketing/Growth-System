// Supabase admin client + service_catalog lookup (service role, server-side only).
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { ServiceConfig, ServiceType } from "./providers.ts";

export function admin(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

export async function getServiceConfig(db: SupabaseClient, serviceType: ServiceType): Promise<ServiceConfig> {
  const { data, error } = await db
    .from("service_catalog")
    .select("*")
    .eq("service_type", serviceType)
    .single();
  if (error || !data) throw new Error(`No service_catalog row for ${serviceType}: ${error?.message ?? "not found"}`);
  return data as ServiceConfig;
}
