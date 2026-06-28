// SERVER-ONLY invite email helper. Import only from route handlers.
import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "./supabase/admin";

export type InviteSendResult = {
  emailed: boolean; // true ONLY when Supabase confirmed it sent the email
  inviteUrl: string; // copy-link fallback (always usable)
  note: string | null;
};

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
}): Promise<InviteSendResult> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return { emailed: false, inviteUrl: params.redirectTo, note: "email_not_configured" };
  }

  const { error } = await admin.auth.admin.inviteUserByEmail(params.email, {
    redirectTo: params.redirectTo,
    data: params.fullName ? { full_name: params.fullName } : undefined,
  });
  if (!error) {
    return { emailed: true, inviteUrl: params.redirectTo, note: null };
  }

  // Existing account → send a magic sign-in link to the accept page.
  if (/already|registered|exists/i.test(error.message)) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (url && key) {
      const anon = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error: otpError } = await anon.auth.signInWithOtp({
        email: params.email,
        options: { shouldCreateUser: false, emailRedirectTo: params.redirectTo },
      });
      if (!otpError) {
        return { emailed: true, inviteUrl: params.redirectTo, note: "existing_account" };
      }
    }
    return { emailed: false, inviteUrl: params.redirectTo, note: "existing_account" };
  }

  // Any other failure: do NOT claim the email was sent.
  return { emailed: false, inviteUrl: params.redirectTo, note: "send_failed" };
}
