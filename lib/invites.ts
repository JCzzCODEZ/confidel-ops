// SERVER-ONLY invite email helper. Import only from route handlers.
import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "./supabase/admin";

export type InviteSendResult = {
  emailed: boolean; // true ONLY when Supabase confirmed it sent the email
  inviteUrl: string; // copy-link fallback (always usable)
  note: string | null;
};

// Resolve an existing auth user by email via the admin API. There is no
// getUserByEmail in this auth-js version, so page through listUsers (the service
// role only — never the browser). Returns the user (with user_metadata) or null.
type AdminClient = NonNullable<ReturnType<typeof getSupabaseAdmin>>;
type AdminUser = { id: string; email?: string | null; user_metadata?: Record<string, unknown> };
async function findUserByEmail(admin: AdminClient, email: string): Promise<AdminUser | null> {
  const target = email.trim().toLowerCase();
  const perPage = 200;
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) return null;
    const users = (data?.users ?? []) as AdminUser[];
    const match = users.find((u) => (u.email ?? "").toLowerCase() === target);
    if (match) return match;
    if (users.length < perPage) break; // last page
  }
  return null;
}

// Sends an email so the invitee can reach the accept page:
//  * NEW account  -> admin.inviteUserByEmail (Supabase "Invite user" email).
//  * EXISTING account -> signInWithOtp (Supabase "Magic Link" email) via a
//    non-persistent client using the PUBLISHABLE key. shouldCreateUser:false so
//    it only mails existing accounts. Both paths actually deliver an email.
// Never claims an email was sent unless Supabase confirmed it.
export async function sendInviteEmail(params: {
  email: string;
  redirectTo: string;
  fullName?: string | null;
  language?: "en" | "es";
}): Promise<InviteSendResult> {
  // Non-authoritative metadata for per-email template localization. Role is NOT
  // placed in metadata — it lives in company_invites and is enforced there.
  const lang = params.language === "es" ? "es" : "en";
  const metadata: Record<string, unknown> = { preferred_language: lang };
  if (params.fullName) metadata.full_name = params.fullName;
  // Safe diagnostic: error CODE/STATUS only — never the key, email, or token.
  const codeOf = (e: unknown) => {
    const x = e as { code?: string; status?: number; name?: string } | null;
    return x?.code ?? (x?.status != null ? String(x.status) : x?.name ?? "unknown");
  };

  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("[invite] admin client unavailable — SUPABASE_SERVICE_ROLE_KEY is not set on the server");
    return { emailed: false, inviteUrl: params.redirectTo, note: "email_not_configured" };
  }

  const { error } = await admin.auth.admin.inviteUserByEmail(params.email, {
    redirectTo: params.redirectTo,
    data: metadata,
  });
  if (!error) {
    return { emailed: true, inviteUrl: params.redirectTo, note: null };
  }
  console.error(`[invite] inviteUserByEmail failed: ${codeOf(error)}`);

  // Existing account → send a magic sign-in link to the accept page.
  if (/already|registered|exists/i.test(error.message)) {
    // signInWithOtp({ data }) does NOT reliably update an existing user's
    // metadata, so the Magic Link template can't read preferred_language from it.
    // Authoritatively merge the language into the user's user_metadata first
    // (preserving any existing keys), THEN send the OTP email.
    const existing = await findUserByEmail(admin, params.email);
    if (existing) {
      const merged = { ...(existing.user_metadata ?? {}), preferred_language: lang };
      const { error: updErr } = await admin.auth.admin.updateUserById(existing.id, {
        user_metadata: merged,
      });
      if (updErr) console.error(`[invite] updateUserById failed: ${codeOf(updErr)}`);
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (url && key) {
      const anon = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error: otpError } = await anon.auth.signInWithOtp({
        email: params.email,
        options: { shouldCreateUser: false, emailRedirectTo: params.redirectTo, data: { preferred_language: lang } },
      });
      if (!otpError) {
        return { emailed: true, inviteUrl: params.redirectTo, note: "existing_account" };
      }
      console.error(`[invite] signInWithOtp failed: ${codeOf(otpError)}`);
    }
    return { emailed: false, inviteUrl: params.redirectTo, note: "existing_account" };
  }

  // Any other failure: do NOT claim the email was sent. Surface the code.
  return { emailed: false, inviteUrl: params.redirectTo, note: `send_failed:${codeOf(error)}` };
}
