"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { acceptInvite, getSessionProfile } from "../../lib/confidel-api";
import { hasEmployeeAccess, hasOwnerAccess } from "../../lib/auth";
import { createSupabaseBrowserClient } from "../../lib/supabase/client";

export function LoginLanding() {
  const router = useRouter();
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
        setError("Session check timed out. Please refresh or sign in again.");
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
          setError("No active membership yet. Ask your owner to invite this email, then sign in again.");
        }
      } catch {
        if (active) {
          setError("Couldn’t verify your session. Please sign in.");
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
      setError(signInError?.message ?? "Unable to sign in.");
      setLoading(false);
      return;
    }

    try {
      const routed = await resolveAndRoute(data.session.access_token);
      if (!routed) {
        setError("No active membership yet. Ask your owner to invite this email, then sign in again.");
        setLoading(false);
      }
    } catch (profileError) {
      setError(profileError instanceof Error ? profileError.message : "Unable to load profile.");
      setLoading(false);
    }
  }

  if (booting) {
    return (
      <main className="screen">
        <div className="shell loading" data-testid="auth-loading">
          Opening Confidel
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
              <p className="brand-subtitle">Operations</p>
            </div>
          </div>
        </header>

        <div className="login-grid">
          <section className="panel hero-panel">
            <div>
              <p className="eyebrow">Private operations suite</p>
              <h1>Confidel</h1>
            </div>
            <p className="hero-copy">
              A focused workspace for clients, jobs, employee completions, invoices, and payments.
            </p>
          </section>

          <section className="panel">
            <div className="section-head">
              <div>
                <h2>Sign in</h2>
                <p>Secure access for owners, admins, and field employees.</p>
              </div>
            </div>

            <form className="stack" onSubmit={handleSubmit}>
              <label>
                Email
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
                Password
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
                {loading ? "Signing in" : "Sign in"}
              </button>
            </form>
          </section>
        </div>
      </div>
    </main>
  );
}
