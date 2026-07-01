"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { acceptInvite, getSessionProfile } from "../../lib/confidel-api";
import { hasEmployeeAccess, hasOwnerAccess } from "../../lib/auth";
import { createSupabaseBrowserClient } from "../../lib/supabase/client";
import { useEmployeeLang } from "../../lib/i18n/employee";
import { LanguageSelector } from "../i18n/language-selector";

export function LoginLanding() {
  const router = useRouter();
  const { lang, setLang, t } = useEmployeeLang();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Resolve a freshly authenticated session to a dashboard. If the user has no
  // active membership yet, try accepting a pending invite (email-matched), then
  // re-check. Returns true if it routed somewhere.
  async function resolveAndRoute(token: string): Promise<boolean> {
    let profile = await getSessionProfile({ token });
    if (!hasOwnerAccess(profile) && !hasEmployeeAccess(profile)) {
      try {
        await acceptInvite({ token });
        profile = await getSessionProfile({ token });
      } catch {
        // ignore — fall through to "no membership" handling
      }
    }
    if (hasOwnerAccess(profile)) {
      router.replace("/owner");
      return true;
    }
    if (hasEmployeeAccess(profile)) {
      router.replace("/employee");
      return true;
    }
    return false;
  }

  useEffect(() => {
    let active = true;

    // Timeout protection: never let the boot screen spin forever.
    const timeout = setTimeout(() => {
      if (active) {
        setError(t("err.sessionTimeout"));
        setBooting(false);
      }
    }, 8000);

    async function routeExistingSession() {
      try {
        const supabase = createSupabaseBrowserClient();
        const {
          data: { session },
          error: sessionError,
        } = await supabase.auth.getSession();

        if (sessionError) {
          throw sessionError;
        }

        if (!active) {
          return;
        }

        if (!session?.access_token) {
          // No session: stay on the login screen (finally clears booting).
          return;
        }

        const routed = await resolveAndRoute(session.access_token);

        if (!active) {
          return;
        }

        if (!routed) {
          setError(t("err.noMembership"));
        }
      } catch {
        if (active) {
          setError(t("err.verifySession"));
        }
      } finally {
        if (active) {
          clearTimeout(timeout);
          setBooting(false);
        }
      }
    }

    routeExistingSession();

    return () => {
      active = false;
      clearTimeout(timeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    const supabase = createSupabaseBrowserClient();
    const { data, error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError || !data.session?.access_token) {
      setError(t("err.unableSignIn"));
      setLoading(false);
      return;
    }

    try {
      const routed = await resolveAndRoute(data.session.access_token);
      if (!routed) {
        setError(t("err.noMembership"));
        setLoading(false);
      }
    } catch {
      setError(t("err.unableLoadProfile"));
      setLoading(false);
    }
  }

  if (booting) {
    return (
      <main className="screen">
        <div className="shell loading" data-testid="auth-loading">
          {t("boot.opening")}
        </div>
      </main>
    );
  }

  return (
    <main className="screen" data-testid="login-screen">
      <div className="shell">
        <header className="topbar">
          <div className="brand-mark">
            <div className="brand-seal">
              <img
                src="/confidel-logo.png"
                alt="Confidel"
                style={{ width: "100%", height: "100%", objectFit: "contain", borderRadius: "50%" }}
              />
            </div>
            <div>
              <p className="brand-title">Confidel</p>
              <p className="brand-subtitle">{t("brand.operations")}</p>
            </div>
          </div>
          <LanguageSelector lang={lang} onChange={setLang} ariaLabel={t("lang.aria")} />
        </header>

        <div className="login-grid">
          <section className="panel hero-panel">
            <div>
              <p className="eyebrow">{t("login.eyebrow")}</p>
              <h1>Confidel</h1>
            </div>
            <p className="hero-copy">{t("login.heroCopy")}</p>
          </section>

          <section className="panel">
            <div className="section-head">
              <div>
                <h2>{t("login.signIn")}</h2>
                <p>{t("login.subtitle")}</p>
              </div>
            </div>

            <form className="stack" onSubmit={handleSubmit}>
              <label>
                {t("login.email")}
                <input
                  autoComplete="email"
                  data-testid="login-email"
                  name="email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </label>

              <label>
                {t("login.password")}
                <input
                  autoComplete="current-password"
                  data-testid="login-password"
                  name="password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </label>

              {error ? (
                <div className="notice error" data-testid="auth-error">
                  {error}
                </div>
              ) : null}

              <button className="btn gold" data-testid="login-submit" disabled={loading} type="submit">
                {loading ? t("login.signingIn") : t("login.signIn")}
              </button>
            </form>
          </section>
        </div>
      </div>
    </main>
  );
}
