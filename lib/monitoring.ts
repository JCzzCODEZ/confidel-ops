// Optional, dependency-free error reporting.
//
// If a Sentry DSN is configured it sends a minimal error event to Sentry's
// ingest endpoint over HTTP (no SDK, no build impact). If no DSN is set it is a
// no-op, so local dev and CI work without any monitoring configured. It never
// throws and never blocks the request — fire and forget.
//
// Env vars (DSNs are public ingest keys, not secrets):
//   SENTRY_DSN              — server / API route errors
//   NEXT_PUBLIC_SENTRY_DSN  — client / frontend errors (and server fallback)

type Side = "server" | "client";

function parseDsn(dsn: string) {
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\//, "");
    const publicKey = url.username;
    if (!projectId || !publicKey) return null;
    return { protocol: url.protocol.replace(":", ""), host: url.host, projectId, publicKey };
  } catch {
    return null;
  }
}

function dsnFor(side: Side): string | undefined {
  if (side === "client") return process.env.NEXT_PUBLIC_SENTRY_DSN || undefined;
  return process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN || undefined;
}

function eventId() {
  const uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return uuid.replace(/-/g, "");
}

function buildEvent(error: unknown, side: Side, context?: Record<string, unknown>) {
  const value = error instanceof Error ? error.message : String(error);
  const type = error instanceof Error ? error.name : "Error";
  const stack = error instanceof Error ? error.stack : undefined;
  return {
    platform: "javascript",
    level: "error",
    environment: process.env.NODE_ENV ?? "production",
    tags: { side },
    exception: { values: [{ type, value }] },
    extra: { ...context, stack },
  };
}

async function send(dsn: string, error: unknown, side: Side, context?: Record<string, unknown>) {
  const parsed = parseDsn(dsn);
  if (!parsed) return;

  const id = eventId();
  const url =
    `${parsed.protocol}://${parsed.host}/api/${parsed.projectId}/envelope/` +
    `?sentry_key=${parsed.publicKey}&sentry_version=7`;
  const body =
    JSON.stringify({ event_id: id, sent_at: new Date().toISOString() }) +
    "\n" +
    JSON.stringify({ type: "event" }) +
    "\n" +
    JSON.stringify({ event_id: id, timestamp: Date.now() / 1000, ...buildEvent(error, side, context) });

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope" },
      body,
      keepalive: true,
    });
  } catch {
    // monitoring must never affect the app
  }
}

// Server / API route errors. Awaitable but safe to ignore.
export async function captureServerError(error: unknown, context?: Record<string, unknown>) {
  const dsn = dsnFor("server");
  if (!dsn) return;
  await send(dsn, error, "server", context);
}

// Client / frontend errors. Fire and forget.
export function captureClientError(error: unknown, context?: Record<string, unknown>) {
  const dsn = dsnFor("client");
  if (!dsn) return;
  void send(dsn, error, "client", context);
}
