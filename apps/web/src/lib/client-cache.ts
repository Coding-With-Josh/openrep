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

// minimum time a real (uncached) loading state stays visible before its
// result paints. a local fetch resolves in tens of milliseconds, which would
// flash the loading orb for a single frame; enforcing one full thinking-orb
// sweep (~700ms at size 20) makes the state readable instead of a flicker.
// cache hits are exempt on purpose: instant reload paints were the explicit
// requirement, so they never wait on this.
export const MIN_LOADING_MS = 700;

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
export type CachedDataOptions<T> = {
  // decides whether a background load wins over what is already on screen.
  // default is fresh-wins. pass a custom merge when a stale GET can resolve
  // after a mutation commit (chat transcript: a pre-flight GET lands after
  // the chat POST wrote the newer transcript). runs as merge(current, fresh).
  merge?: (prev: T, fresh: T) => T;
};

export function useCachedData<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  options?: CachedDataOptions<T>,
): {
  data: T | null;
  error: string | null;
  locked: boolean;
  reload: () => void;
  // writes a server-returned fresh value (e.g. the full transcript the chat
  // POST already returned) into state and the cache, avoiding a re-fetch.
  commit: (value: T) => void;
  // marks this key as locked (403 from a mutation, e.g. chat POST): the
  // session key is gone, so fail closed to the locked state and drop the
  // cached copy rather than showing stale data as live.
  lock: () => void;
} {
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const mergeRef = useRef(options?.merge);
  mergeRef.current = options?.merge;
  const keyRef = useRef(key);
  keyRef.current = key;

  const [data, setData] = useState<T | null>(() => (key !== null ? cacheGet<T>(key) : null));
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [nonce, setNonce] = useState(0);
  const dataRef = useRef(data);
  dataRef.current = data;
  const loadStartedAtRef = useRef(0);
  const holdTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    // a genuine load: nothing is on screen yet, the loading orb is visible,
    // and its result must be held for MIN_LOADING_MS so the animation reads.
    const cached = cacheGet<T>(key);
    const genuineLoad = cached === null && dataRef.current === null;
    if (genuineLoad) loadStartedAtRef.current = Date.now();
    if (cached !== null) {
      setData(cached);
      setLocked(false);
      setError(null);
    }
    // applies a state transition, holding it to the minimum loading span
    // when the orb is actually on screen (cache-hit revalidation is exempt).
    const apply = (fn: () => void) => {
      if (cancelled) return;
      if (!genuineLoad) {
        fn();
        return;
      }
      const elapsed = Date.now() - loadStartedAtRef.current;
      const remaining = MIN_LOADING_MS - elapsed;
      if (remaining <= 0) {
        fn();
        return;
      }
      holdTimerRef.current = window.setTimeout(() => {
        if (cancelled) return;
        holdTimerRef.current = null;
        fn();
      }, remaining);
    };
    const load = async () => {
      try {
        const fresh = await fetcherRef.current();
        apply(() => {
          // merge guards the check-then-write race where a GET resolves after
          // a mutation commit: without it, the stale fetch would overwrite the
          // fresher transcript/score already on screen.
          const prev = dataRef.current;
          const next =
            prev !== null && mergeRef.current ? mergeRef.current(prev, fresh) : fresh;
          setData(next);
          setLocked(false);
          setError(null);
          cacheSet(key, next);
        });
      } catch (err) {
        apply(() => {
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
        });
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (holdTimerRef.current !== null) {
        window.clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
    };
  }, [key, nonce]);

const reload = useCallback(() => setNonce((n) => n + 1), []);
  const commit = useCallback((value: T) => {
    setData(value);
    if (keyRef.current !== null) cacheSet(keyRef.current, value);
  }, []);
  const lock = useCallback(() => {
    if (keyRef.current !== null) {
      memory.delete(keyRef.current);
      const s = storage();
      if (s !== null) {
        try {
          s.removeItem(`openrep:${keyRef.current}`);
        } catch {
          // ignore storage failures on the purge path
        }
      }
    }
    setLocked(true);
  }, []);

  return { data, error, locked, reload, commit, lock };
}