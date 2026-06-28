"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { acceptInvite, getSessionProfile } from "../../lib/confidel-api";
import { getApiOptions, hasOwnerAccess } from "../../lib/auth";
import { createSupabaseBrowserClient } from "../../lib/supabase/client";

type Phase = "loading" | "ready" | "expired" | "no_invite" | "done" | "error";

export default function AcceptInvitePage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("loading");
  const [email, setEmail] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [setPasswordMode, setSetPasswordMode] = useState(true);
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function init() {
      try {
        const supabase = createSupabaseBrowserClient();
        const url = new URL(window.location.href);
        setInviteToken(url.searchParams.get("invite"));
        const code = url.searchParams.get("code");
        let session = (await supabase.auth.getSession()).data.session;
        if (!session && code) {
          const exchanged = await supabase.auth.exchangeCodeForSession(code);
          session = exchanged.data.session ?? null;
        }
        if (!active) return;
        if (!session?.user?.email) {
          setPhase("expired");
          return;
        }
        setEmail(session.user.email);

        // The invitee can read only their own pending invite (RLS by auth email).
        const { data: invites } = await supabase
          .from("company_invites")
          .select("id, role, status, expires_at")
          .eq("status", "pending");
        const invite = (invites ?? [])[0];
        if (!active) return;
        if (!invite) {
          setPhase("no_invite");
          return;
        }
        setRole(invite.role);
        setPhase("ready");
      } catch {
        if (active) setPhase("error");
      }
    }
    init();
    return () => {
      active = false;
    };
  }, []);

  async function handleAccept() {
    setBusy(true);
    setError(null);
    try {
      const supabase = createSupabaseBrowserClient();
      if (setPasswordMode) {
        if (password.length < 8) {
          setError("Password must be at least 8 characters.");
          setBusy(false);
          return;
        }
        if (password !== confirm) {
          setError("Passwords do not match.");
          setBusy(false);
          return;
        }
        const { error: pwError } = await supabase.auth.updateUser({ password });
        if (pwError) {
          setError(pwError.message);
          setBusy(false);
          return;
        }
      }

      const options = await getApiOptions();
      if (!options) {
        setPhase("expired");
        return;
      }
      const res = await acceptInvite(options, inviteToken ?? undefined);
      if (!res.result?.accepted) {
        setError("This invitation can't be accepted — it may be expired, revoked, or already used.");
        setBusy(false);
        return;
      }
      const profile = await getSessionProfile(options);
      setPhase("done");
      router.replace(hasOwnerAccess(profile) ? "/owner" : "/employee");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong accepting the invitation.");
      setBusy(false);
    }
  }

  return (
    <main className="screen">
      <div className="shell" style={{ maxWidth: 480, margin: "0 auto", padding: "2rem" }}>
        <div className="brand-mark" style={{ marginBottom: "1rem" }}>
          <div className="brand-seal">
            <img src="/confidel-logo.png" alt="Confidel" style={{ width: "100%", height: "100%", objectFit: "contain", borderRadius: "50%" }} />
          </div>
          <div>
            <p className="brand-title">Confidel</p>
            <p className="brand-subtitle">Accept invitation</p>
          </div>
        </div>

        {phase === "loading" ? <p className="muted" data-testid="accept-loading">Checking your invitation…</p> : null}

        {phase === "expired" ? (
          <div className="notice error" data-testid="accept-expired">
            This invitation link is invalid or has expired. Ask your owner to resend the invitation.
          </div>
        ) : null}

        {phase === "no_invite" ? (
          <div className="notice error" data-testid="accept-no-invite">
            No pending invitation was found for {email ?? "this account"}. The email must match the one you were invited with.
          </div>
        ) : null}

        {phase === "error" ? (
          <div className="notice error" data-testid="accept-error">Something went wrong. Please reopen the link or ask for a new invitation.</div>
        ) : null}

        {phase === "done" ? <p className="muted" data-testid="accept-done">Invitation accepted — taking you to your dashboard…</p> : null}

        {phase === "ready" ? (
          <div className="stack" data-testid="accept-ready">
            <p>
              You&apos;ve been invited to Confidel as <strong>{role}</strong>.
            </p>
            <p className="muted small">Signed in as {email}</p>

            {setPasswordMode ? (
              <>
                <label>
                  Create a password
                  <input
                    type="password"
                    data-testid="accept-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                  />
                </label>
                <label>
                  Confirm password
                  <input
                    type="password"
                    data-testid="accept-confirm"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    autoComplete="new-password"
                  />
                </label>
                <button
                  type="button"
                  className="btn secondary"
                  onClick={() => setSetPasswordMode(false)}
                  data-testid="accept-have-password"
                >
                  I already have a password
                </button>
              </>
            ) : (
              <p className="muted small">
                Continuing with your existing password.{" "}
                <button type="button" className="btn secondary" onClick={() => setSetPasswordMode(true)}>
                  Set a new password instead
                </button>
              </p>
            )}

            {error ? <div className="notice error" data-testid="accept-form-error">{error}</div> : null}

            <button className="btn gold wide" type="button" disabled={busy} onClick={handleAccept} data-testid="accept-submit">
              {busy ? "Accepting…" : "Accept invitation"}
            </button>
          </div>
        ) : null}
      </div>
    </main>
  );
}
