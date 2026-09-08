"use client";

import { useCallback, useEffect, useState } from "react";

// bootstraps the server-side session cookie on mount. the server either
// returns the existing session for an already-set cookie or mints a fresh
// guest one and sets it. every api call below is blocked behind `ready` so
// nothing fires with a missing or unknown session. re-mounting is idempotent.
export function useGuestSession() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<{ userId: string; createdAt: string } | null>(null);

  const bootstrap = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/session", { method: "POST" });
      if (!res.ok) {
        setReady(true);
        setError("could not start a session, try again shortly");
        return;
      }
      const body = await res.json();
      setSession(body);
      setReady(true);
    } catch {
      setReady(true);
      setError("could not reach the server, check your connection");
    }
  }, []);

  useEffect(() => {
    if (!ready) void bootstrap();
  }, [ready, bootstrap]);

  return { ready, error, session };
}
