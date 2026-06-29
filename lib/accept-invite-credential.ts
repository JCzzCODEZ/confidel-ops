// Pure, dependency-free helpers for the /accept-invite session bootstrap.
// No React, no DOM, no Supabase — so the decision logic is unit-testable in
// isolation (see scripts/accept-invite-credential.test.ts).

// Where the invite token is stashed after we strip it from the URL.
export const INVITE_STASH_KEY = "confidel.invite.token";

// Email-link OTP types Supabase may deliver to this page.
export const EMAIL_OTP_TYPES = [
  "invite",
  "magiclink",
  "signup",
  "recovery",
  "email",
  "email_change",
] as const;
export type EmailOtp = (typeof EMAIL_OTP_TYPES)[number];
export function isEmailOtpType(v: string | null): v is EmailOtp {
  return !!v && (EMAIL_OTP_TYPES as readonly string[]).includes(v);
}

export type CredentialInput = {
  tokenHash: string | null;
  otpType: string | null;
  code: string | null;
  hashAccess: string | null;
  hashRefresh: string | null;
  hashError: string | null;
};

export type CredentialDecision =
  | { kind: "verify"; tokenHash: string; otpType: EmailOtp }
  | { kind: "exchange"; code: string }
  | { kind: "setSession"; accessToken: string; refreshToken: string }
  | { kind: "existing" }
  | { kind: "link_error"; reason: "conflict" | "hash_error" | "partial_hash" | "bad_type" };

// Decide which ONE credential mechanism the email link delivered. Rejects:
//  - an error fragment from Supabase (`#error=...`)
//  - a PARTIAL implicit hash (only access_token OR only refresh_token)
//  - MORE THAN ONE credential present at once (token_hash + code + full hash)
//  - a token_hash with an invalid/absent `type`
// Only when no link credential is present do we fall back to an existing session.
export function decideCredential(i: CredentialInput): CredentialDecision {
  const hasFullHash = Boolean(i.hashAccess && i.hashRefresh);
  const hasAnyHash = Boolean(i.hashAccess || i.hashRefresh);
  const hasPartialHash = hasAnyHash && !hasFullHash;

  if (i.hashError) return { kind: "link_error", reason: "hash_error" };
  if (hasPartialHash) return { kind: "link_error", reason: "partial_hash" };

  const credentialCount = (i.tokenHash ? 1 : 0) + (i.code ? 1 : 0) + (hasFullHash ? 1 : 0);
  if (credentialCount > 1) return { kind: "link_error", reason: "conflict" };

  if (i.tokenHash) {
    if (!isEmailOtpType(i.otpType)) return { kind: "link_error", reason: "bad_type" };
    return { kind: "verify", tokenHash: i.tokenHash, otpType: i.otpType };
  }
  if (i.code) return { kind: "exchange", code: i.code };
  if (hasFullHash) {
    return { kind: "setSession", accessToken: i.hashAccess as string, refreshToken: i.hashRefresh as string };
  }
  return { kind: "existing" };
}

// Strip invite + every credential (query AND hash) from a URL string.
export function cleanInviteHref(href: string): string {
  const u = new URL(href);
  for (const p of ["invite", "token_hash", "code", "type"]) u.searchParams.delete(p);
  u.hash = "";
  return u.toString();
}

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

// Persist the URL invite token to storage (so a reload keeps it), or restore it
// when the URL no longer carries one. Falls back to the URL value if storage throws.
export function resolveInviteToken(inviteParam: string | null, storage: StorageLike | null): string | null {
  if (!storage) return inviteParam;
  try {
    if (inviteParam) {
      storage.setItem(INVITE_STASH_KEY, inviteParam);
      return inviteParam;
    }
    return storage.getItem(INVITE_STASH_KEY);
  } catch {
    return inviteParam;
  }
}
