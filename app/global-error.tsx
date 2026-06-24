"use client";

import { useEffect } from "react";
import { captureClientError } from "../lib/monitoring";

// Next.js App Router global error boundary. Reports the error to monitoring
// (no-op if no DSN configured) and shows a minimal recovery screen.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureClientError(error, { digest: error.digest });
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main className="screen">
          <div className="shell" style={{ textAlign: "center", padding: "2rem" }}>
            <h2>Something went wrong</h2>
            <p className="muted">An unexpected error occurred. You can try again.</p>
            <button className="btn gold" type="button" onClick={() => reset()}>
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
