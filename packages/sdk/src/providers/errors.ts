// provider-layer error types. ProviderApiError is thrown by the adapters on
// non-2xx / malformed responses and is mapped to PROVIDER_API_FAILURE by the
// run loop. ProviderConfigError is thrown only by createProviderClient when
// an unknown provider string is passed; it is a programming error in the
// caller, distinct from a runtime provider failure.

// carries the provider's http status so the web layer can distinguish a
// retryable rate limit (429) from a hard provider failure (5xx) instead of
// collapsing both into 502. retryAfterSeconds is the provider's retry-after
// header parsed as seconds; undefined when absent or unparseable. both
// fields are plain numbers, never derived from the response body.
export class ProviderApiError extends Error {
  readonly status?: number;
  readonly retryAfterSeconds?: number;

  constructor(message: string, status?: number, retryAfterSeconds?: number) {
    super(message);
    this.name = "ProviderApiError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

// parses a provider retry-after header into whole seconds. undefined when
// the header is missing or not a non-negative integer; the web layer then
// applies its own default. the value never comes from the response body.
export function retryAfterSeconds(response: {
  headers?: { get?: (name: string) => string | null };
}): number | undefined {
  const raw = response.headers?.get?.("retry-after");
  if (raw === undefined || raw === null) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}