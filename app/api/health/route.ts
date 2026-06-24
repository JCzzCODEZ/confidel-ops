import { json } from "../_shared";

export const dynamic = "force-dynamic";

// Public health check — no auth, no secrets. Useful for uptime monitors and
// post-deploy smoke checks. `supabaseConfigured` only reports presence, not values.
export async function GET() {
  return json({
    status: "ok",
    app: "Confidel Ops",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV ?? "unknown",
    supabaseConfigured: Boolean(
      process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    ),
  });
}
