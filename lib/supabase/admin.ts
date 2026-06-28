// SERVER-ONLY Supabase admin client (service-role).
//
// SECURITY:
//  * Uses SUPABASE_SERVICE_ROLE_KEY — a server-only env var. It is NEVER prefixed
//    with NEXT_PUBLIC_, so Next.js cannot inline it into a client bundle.
//  * Import this ONLY from route handlers / server code. Never from a client
//    ("use client") component.
//  * Never return, log, or expose the key.
//
// `getSupabaseAdmin()` returns null when the key isn't configured, so the app
// still works (with the copy-link fallback) in environments without it.
import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function isAdminConfigured(): boolean {
  return Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NEXT_PUBLIC_SUPABASE_URL);
}

export function getSupabaseAdmin(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Where invite acceptance links should point.
export function appUrl(fallback: string): string {
  return process.env.APP_URL || fallback;
}
