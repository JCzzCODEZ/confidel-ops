"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { acceptInvite, getSessionProfile } from "../../lib/confidel-api";
import { getApiOptions, hasOwnerAccess } from "../../lib/auth";
import { createSupabaseBrowserClient } from "../../lib/supabase/client";

type Phase = "loading" | "ready" | "expired" | "no_invite" | "done" | "error";
type Lang = "en" | "es";

const MIN_PASSWORD = 8;

// Default safely to English for any missing or invalid language value.
function normalizeLang(value: string | null | undefined): Lang {
  return value === "es" ? "es" : "en";
}

// Every visible string lives here in both languages. Language has no
// authorization effect — it only selects presentation.
const STRINGS: Record<Lang, {
  subtitle: string;
  loading: string;
  expired: string;
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

  useEffect(() => {
    let active = true;
    async function init() {
      try {
        const supabase = createSupabaseBrowserClient();
        const url = new URL(window.location.href);
        // Default the page to the invitation language carried in the URL.
        setLang(normalizeLang(url.searchParams.get("lang")));
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
          .select("id, role, status, expires_at, preferred_language")
          .eq("status", "pending");
        const invite = (invites ?? [])[0];
        if (!active) return;
        if (!invite) {
          setPhase("no_invite");
          return;
        }
        // Prefer the saved invitation language when present (URL may be absent).
        if (invite.preferred_language) setLang(normalizeLang(invite.preferred_language));
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
