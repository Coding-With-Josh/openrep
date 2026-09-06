// provider-layer error types. ProviderApiError is thrown by the adapters on
// non-2xx / malformed responses and is mapped to PROVIDER_API_FAILURE by the
// run loop. ProviderConfigError is thrown only by createProviderClient when
// an unknown provider string is passed; it is a programming error in the
// caller, distinct from a runtime provider failure.

export class ProviderApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderApiError";
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