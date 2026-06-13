import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "./env.js";

export function createSupabaseClient(env: Env): SupabaseClient {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set to create a Supabase client",
    );
  }
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
}
