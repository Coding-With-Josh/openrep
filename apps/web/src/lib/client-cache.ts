"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// client-side cache for read-only api responses. lives in sessionStorage so
// a reload paints instantly from the previous fetch, while the page still
// revalidates in the background. only GET data is cached here: mutations
// (session mint, create, chat) never write through this module.
//
// fail-closed rule for identity: callers must key entries by the userId the
// server just confirmed in this load (the session bootstrap response), never
// by a client-derived identity. if the cookie changed or expired, the key
// changes and the stale entry is unreachable, so one session can never flash
// another session's data.

const memory = new Map<string, unknown>();

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function cacheGet<T>(key: string): T | null {
  if (memory.has(key)) return memory.get(key) as T;
  const s = storage();
  if (s === null) return null;
  try {
    const raw = s.getItem(`openrep:${key}`);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch {
    // corrupt or unparseable entry: fail closed to a miss, never to stale data.
    return null;
  }
}

export function cacheSet<T>(key: string, value: T): void {
  memory.set(key, value);
  const s = storage();
  if (s === null) return;
  try {
    s.setItem(`openrep:${key}`, JSON.stringify(value));
  } catch {
    // storage full or blocked (private mode); the in-memory copy still covers
    // this page session, background revalidation keeps it fresh.
  }
}

// cache-fetching fetch error carrying the server's status code, so callers
// can distinguish a locked/expired state from a generic failure.
export class CachedFetchError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "CachedFetchError";
    this.status = status;
  }
}

// parses a fetch response for the cached-data layer: 2xx becomes the json
// body, anything else becomes a CachedFetchError carrying the http status
// (403 is how the api expresses a missing/live-session key, which the cache
// layer maps to the locked state; other statuses surface as errors).
export async function cachedFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // non-json body (or empty); keep body null and build a message below.
  }
  if (!res.ok) {
    const message =
      body !== null &&
      typeof body === "object" &&
      "error" in body &&
      (body as { error?: { message?: string } }).error?.message
        ? ((body as { error: { message: string } }).error.message)
        : `request failed with status ${res.status}`;
    throw new CachedFetchError(message, res.status);
  }
  return body as T;
}

// fetches a GET endpoint with sessionStorage-backed caching. renders the
// cached copy instantly on reload while revalidating in the background.
// `key` must already include the server-confirmed session userId (see the
// fail-closed identity rule at the top of this file); a null key (session
// not yet known) skips loading. when revalidation fails but a cached copy
// exists, the stale copy stays visible and the refresh error is surfaced
// separately rather than wiping the screen.
export function useCachedData<T>(
  key: string | null,
  fetcher: () => Promise<T>,
): {
  data: T | null;
  error: string | null;
  locked: boolean;
  reload: () => void;
  // writes a server-returned fresh value (e.g. the full transcript the chat
  // POST already returned) into state and the cache, avoiding a re-fetch.
  commit: (value: T) => void;
} {
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const keyRef = useRef(key);
  keyRef.current = key;

  const [data, setData] = useState<T | null>(() => (key !== null ? cacheGet<T>(key) : null));
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    // instant paint from the cache for this identity before the fetch returns.
    const cached = cacheGet<T>(key);
    if (cached !== null) {
      setData(cached);
      setLocked(false);
      setError(null);
    }
    const load = async () => {
      try {
        const fresh = await fetcherRef.current();
        if (cancelled) return;
        setData(fresh);
        setLocked(false);
        setError(null);
        cacheSet(key, fresh);
      } catch (err) {
        if (cancelled) return;
        const status = err instanceof CachedFetchError ? err.status : 0;
        if (status === 403) {
          // session key for this agent no longer exists: locked, fail closed.
          setLocked(true);
          setError(null);
          return;
        }
        if (cacheGet<T>(key) !== null) {
          // keep the cached copy visible, surface the refresh failure gently.
          setError("could not refresh, showing the last loaded copy");
        } else {
          setError(err instanceof Error ? err.message : "could not load, try again shortly");
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [key, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const commit = useCallback((value: T) => {
    setData(value);
    if (keyRef.current !== null) cacheSet(keyRef.current, value);
  }, []);


  return { data, error, locked, reload, commit };
}