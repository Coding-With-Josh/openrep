// the storage abstraction the custody resolver walks in precedence order.
// a store returns the secret for an account, null on a normal miss, and
// throws a typed error on a real failure so the resolver can fall back
// loudly rather than silently.

export interface KeyStore {
  kind: "keychain" | "encrypted-file";
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
}

// keychain entry naming convention, documented in technical.md. entries are
// keyed by the agent's canonical id (the public key), never by the mutable
// name, with a distinct suffix per key kind so the identity key and the
// owner key can never collide or be confused.
export function identityAccount(publicKey: string): string {
  return `${publicKey}.identity`;
}

export function ownerAccount(publicKey: string): string {
  return `${publicKey}.owner`;
}

export const SERVICE_NAME = "openrep";

// provider api key naming convention: one entry per provider so a later
// version can store keys for multiple providers side by side
// (apikey/groq, apikey/anthropic, ...). the provider name is never free-form
// input: it comes from the caller against a fixed allow-list, and a stray
// path-ish name is rejected here so an attacker-controlled string can never
// smuggle a traversal into the keychain/service account names.
export function apiKeyAccount(provider: string): string {
  if (provider.length === 0 || provider.length > 64 || provider.includes("/") || provider.includes(".") || provider.includes("..")) {
    throw new TypeError(`invalid provider api key account name: ${provider}`);
  }
  return `apikey/${provider}`;
}

// typed custody failure, with the code vocabulary commands surface in their
// error output. custody errors are cli-side; the sdk itself never sees them.
export class CustodyError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CustodyError";
    this.code = code;
  }
}