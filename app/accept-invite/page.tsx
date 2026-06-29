"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { acceptInvite, getSessionProfile } from "../../lib/confidel-api";
import { getApiOptions, hasOwnerAccess } from "../../lib/auth";
import { createSupabaseBrowserClient } from "../../lib/supabase/client";
import {
  INVITE_STASH_KEY,
  cleanInviteHref,
  decideCredential,
  resolveInviteToken,
} from "../../lib/accept-invite-credential";

type Phase = "loading" | "ready" | "expired" | "no_invite" | "link_error" | "done" | "error";
type Lang = "en" | "es";

const MIN_PASSWORD = 8;

// Default safely to English for any missing or invalid language value.
function normalizeLang(value: string | null | undefined): Lang {
  return value === "es" ? "es" : "en";
}

// Drop the stashed invite token. Called on success AND on every terminal failure
// so a dead token never lingers in sessionStorage.
function clearInviteStash() {
  try {
    window.sessionStorage.removeItem(INVITE_STASH_KEY);
  } catch {
    /* ignore */
  }
}

// Every visible string lives here in both languages. Language has no
// authorization effect — it only selects presentation.
const STRINGS: Record<Lang, {
  subtitle: string;
  loading: string;
  expired: string;
  linkError: string;
  noInvite: (email: string) => string;
  error: string;
  done: string;
  invitedAs: (role: string) => string;
  signedInAs: (email: string) => string;
  createPassword: string;
  confirmPassword: string;
  passwordHint: string;
  havePassword: string;
  usingExisting: string;
  setNewInstead: string;
  accept: string;
  accepting: string;
  errTooShort: string;
  errMismatch: string;
  errCannotAccept: string;
  errGeneric: string;
  roleEmployee: string;
  roleAdmin: string;
}> = {
  en: {
    subtitle: "Accept invitation",
    loading: "Checking your invitation…",
    expired: "This invitation link is invalid or has expired. Ask your owner to resend the invitation.",
    linkError: "We couldn't verify this invitation link. It may have expired or already been used. Ask your owner to resend the invitation.",
    noInvite: (email) => `No pending invitation was found for ${email}. The email must match the one you were invited with.`,
    error: "Something went wrong. Please reopen the link or ask for a new invitation.",
    done: "Invitation accepted — taking you to your dashboard…",
    invitedAs: (role) => `You've been invited to Confidel as ${role}.`,
    signedInAs: (email) => `Signed in as ${email}`,
    createPassword: "Create a password",
    confirmPassword: "Confirm password",
    passwordHint: `Use at least ${MIN_PASSWORD} characters.`,
    havePassword: "I already have a password",
    usingExisting: "Continuing with your existing password.",
    setNewInstead: "Set a new password instead",
    accept: "Accept invitation",
    accepting: "Accepting…",
    errTooShort: `Password must be at least ${MIN_PASSWORD} characters.`,
    errMismatch: "Passwords do not match.",
    errCannotAccept: "This invitation can't be accepted — it may be expired, revoked, or already used.",
    errGeneric: "Something went wrong accepting the invitation.",
    roleEmployee: "an employee",
    roleAdmin: "an admin",
  },
  es: {
    subtitle: "Aceptar invitación",
    loading: "Verificando tu invitación…",
    expired: "Este enlace de invitación no es válido o ha expirado. Pídele al propietario que reenvíe la invitación.",
    linkError: "No pudimos verificar este enlace de invitación. Puede haber expirado o ya haberse usado. Pídele al propietario que reenvíe la invitación.",
    noInvite: (email) => `No se encontró ninguna invitación pendiente para ${email}. El correo debe coincidir con el que recibió la invitación.`,
    error: "Algo salió mal. Vuelve a abrir el enlace o solicita una nueva invitación.",
    done: "Invitación aceptada — te llevamos a tu panel…",
    invitedAs: (role) => `Has sido invitado a Confidel como ${role}.`,
    signedInAs: (email) => `Sesión iniciada como ${email}`,
    createPassword: "Crea una contraseña",
    confirmPassword: "Confirma la contraseña",
    passwordHint: `Usa al menos ${MIN_PASSWORD} caracteres.`,
    havePassword: "Ya tengo una contraseña",
    usingExisting: "Continuando con tu contraseña actual.",
    setNewInstead: "Crear una nueva contraseña",
    accept: "Aceptar invitación",
    accepting: "Aceptando…",
    errTooShort: `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`,
    errMismatch: "Las contraseñas no coinciden.",
    errCannotAccept: "Esta invitación no se puede aceptar — puede haber expirado, sido revocada o ya utilizada.",
    errGeneric: "Algo salió mal al aceptar la invitación.",
    roleEmployee: "empleado",
    roleAdmin: "administrador",
  },
};

export default function AcceptInvitePage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("loading");
  const [lang, setLang] = useState<Lang>("en");
  const [email, setEmail] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [setPasswordMode, setSetPasswordMode] = useState(true);
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const t = STRINGS[lang];

  // Run init exactly once (the email token_hash is single-use), AND keep updating
  // state on the live instance under React Strict Mode's dev setup→cleanup→setup.
  // `initRan` dedupes the side effect; `mounted` is re-set true on every setup and
  // only false on real unmount, so the one running init() can still render.
  const initRan = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (initRan.current) return () => { mounted.current = false; };
    initRan.current = true;

    async function init() {
      const supabase = createSupabaseBrowserClient();
      const url = new URL(window.location.href);
      setLang(normalizeLang(url.searchParams.get("lang")));

      // --- Capture every credential + the invite token BEFORE touching the URL --
      const inviteParam = url.searchParams.get("invite");
      const tokenHash = url.searchParams.get("token_hash");
      const otpType = url.searchParams.get("type");
      const code = url.searchParams.get("code");
      // Implicit-flow hash: capture the tokens (and any error) BEFORE we clear the
      // hash, otherwise we'd destroy the session before persisting it.
      const hash = window.location.hash.startsWith("#")
        ? new URLSearchParams(window.location.hash.slice(1))
        : new URLSearchParams();
      const hashAccess = hash.get("access_token");
      const hashRefresh = hash.get("refresh_token");
      const hashError = hash.get("error_description") || hash.get("error");

      // Stash the invite token out of the URL (sessionStorage is never sent in a
      // URL/referrer and survives reloads), then restore it on later loads.
      const storage = (() => {
        try {
          return window.sessionStorage;
        } catch {
          return null;
        }
      })();
      const inviteToken = resolveInviteToken(inviteParam, storage);
      setInviteToken(inviteToken);

      // Mitigation (NOT a full fix): strip invite + credentials from the address
      // bar/history so they don't leak via referrer on later requests. The very
      // first request URL has already reached hosting logs — eliminating that
      // needs a server flow where the app only ever receives a PKCE code/fragment
      // (a server callback alone, with the token still in the query string, does
      // not). See AUDIT_2026-06-28.md.
      const scrubUrl = () => {
        window.history.replaceState({}, "", cleanInviteHref(window.location.href));
      };
      // Terminal failure: drop the dead token and render — only on the live instance.
      const fail = (p: Exclude<Phase, "ready" | "done" | "loading">) => {
        clearInviteStash();
        if (mounted.current) setPhase(p);
      };

      try {
        // --- Pick EXACTLY ONE credential (rejects conflicts, partial hashes,
        // hash errors, bad types). The link credential is authoritative and
        // overrides any account already signed in on this browser. ------------
        const decision = decideCredential({ tokenHash, otpType, code, hashAccess, hashRefresh, hashError });

        let session = null as Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"];
        switch (decision.kind) {
          case "link_error": {
            scrubUrl();
            fail("link_error");
            return;
          }
          case "verify": {
            const { data, error } = await supabase.auth.verifyOtp({
              token_hash: decision.tokenHash,
              type: decision.otpType,
            });
            scrubUrl();
            if (error) {
              fail("link_error");
              return;
            }
            session = data.session ?? null;
            break;
          }
          case "exchange": {
            const { data, error } = await supabase.auth.exchangeCodeForSession(decision.code);
            scrubUrl();
            if (error) {
              fail("link_error");
              return;
            }
            session = data.session ?? null;
            break;
          }
          case "setSession": {
            // Implicit flow: persist the captured tokens, THEN scrub the hash.
            const { data, error } = await supabase.auth.setSession({
              access_token: decision.accessToken,
              refresh_token: decision.refreshToken,
            });
            scrubUrl();
            if (error) {
              fail("link_error");
              return;
            }
            session = data.session ?? null;
            break;
          }
          case "existing": {
            // No link credential — reuse an existing signed-in session.
            session = (await supabase.auth.getSession()).data.session;
            scrubUrl();
            break;
          }
        }

        if (!mounted.current) return;
        if (!session?.user?.email) {
          fail("expired");
          return;
        }
        setEmail(session.user.email);

        // The invitee can read only their own pending invite (RLS by auth email).
        const { data: invites, error: inviteErr } = await supabase
          .from("company_invites")
          .select("id, role, status, expires_at, preferred_language")
          .eq("status", "pending");
        if (!mounted.current) return;
        if (inviteErr) {
          fail("error");
          return;
        }
        const invite = (invites ?? [])[0];
        if (!invite) {
          fail("no_invite");
          return;
        }
        // Prefer the saved invitation language when present (URL may be absent).
        if (invite.preferred_language) setLang(normalizeLang(invite.preferred_language));
        setRole(invite.role);
        setPhase("ready"); // keep the stashed token — handleAccept needs it
      } catch {
        scrubUrl();
        fail("error");
      }
    }
    init();
    return () => {
      mounted.current = false;
    };
  }, []);

  function roleLabel(): string {
    if (role === "admin") return t.roleAdmin;
    if (role === "employee") return t.roleEmployee;
    return role ?? "";
  }

  async function handleAccept() {
    setBusy(true);
    setError(null);
    try {
      const supabase = createSupabaseBrowserClient();
      if (setPasswordMode) {
        if (password.length < MIN_PASSWORD) {
          setError(t.errTooShort);
          setBusy(false);
          return;
        }
        if (password !== confirm) {
          setError(t.errMismatch);
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
        setError(t.errCannotAccept);
        setBusy(false);
        return;
      }
      // Consumed — clear the stashed token so it can't be replayed.
      clearInviteStash();
      const profile = await getSessionProfile(options);
      setPhase("done");
      router.replace(hasOwnerAccess(profile) ? "/owner" : "/employee");
    } catch (err) {
      setError(err instanceof Error ? err.message : t.errGeneric);
      setBusy(false);
    }
  }

  // Switching language only changes local presentation state. The invite token,
  // Auth session, and any typed password are preserved (no reload, no re-auth).
  function LanguageSwitcher() {
    return (
      <div className="button-row" data-testid="accept-lang-switch" style={{ marginBottom: "1rem", gap: "0.25rem" }}>
        <button
          type="button"
          className={`btn ${lang === "en" ? "gold" : "secondary"}`}
          aria-pressed={lang === "en"}
          onClick={() => setLang("en")}
          data-testid="accept-lang-en"
        >
          English
        </button>
        <button
          type="button"
          className={`btn ${lang === "es" ? "gold" : "secondary"}`}
          aria-pressed={lang === "es"}
          onClick={() => setLang("es")}
          data-testid="accept-lang-es"
        >
          Español
        </button>
      </div>
    );
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
            <p className="brand-subtitle">{t.subtitle}</p>
          </div>
        </div>

        <LanguageSwitcher />

        {phase === "loading" ? <p className="muted" data-testid="accept-loading">{t.loading}</p> : null}

        {phase === "expired" ? (
          <div className="notice error" data-testid="accept-expired">{t.expired}</div>
        ) : null}

        {phase === "link_error" ? (
          <div className="notice error" data-testid="accept-link-error">{t.linkError}</div>
        ) : null}

        {phase === "no_invite" ? (
          <div className="notice error" data-testid="accept-no-invite">{t.noInvite(email ?? (lang === "es" ? "esta cuenta" : "this account"))}</div>
        ) : null}

        {phase === "error" ? (
          <div className="notice error" data-testid="accept-error">{t.error}</div>
        ) : null}

        {phase === "done" ? <p className="muted" data-testid="accept-done">{t.done}</p> : null}

        {phase === "ready" ? (
          <div className="stack" data-testid="accept-ready">
            <p data-testid="accept-invited-as">{t.invitedAs(roleLabel())}</p>
            <p className="muted small">{t.signedInAs(email ?? "")}</p>

            {setPasswordMode ? (
              <>
                <label>
                  {t.createPassword}
                  <input
                    type="password"
                    data-testid="accept-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                  />
                </label>
                <p className="muted small">{t.passwordHint}</p>
                <label>
                  {t.confirmPassword}
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
                  {t.havePassword}
                </button>
              </>
            ) : (
              <p className="muted small">
                {t.usingExisting}{" "}
                <button type="button" className="btn secondary" onClick={() => setSetPasswordMode(true)}>
                  {t.setNewInstead}
                </button>
              </p>
            )}

            {error ? <div className="notice error" data-testid="accept-form-error">{error}</div> : null}

            <button className="btn gold wide" type="button" disabled={busy} onClick={handleAccept} data-testid="accept-submit">
              {busy ? t.accepting : t.accept}
            </button>
          </div>
        ) : null}
      </div>
    </main>
  );
}
