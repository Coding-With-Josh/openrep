// sdk-side session key custody primitives: envelope encryption of an agent
// private key under a server master key, plus the master key loader. this is
// the web-app/server half of the key custody policy in technical.md and the
// types/security.ts contract; the cli's custody system (packages/cli/src/
// custody/) is a separate system for a different context and shares nothing
// with this module.
//
// design decisions (each locked in the session-key persistence pass):
// - the master key env var is OPENREP_MASTER_ENCRYPTION_KEY, the same
//   variable loadEnvConfig() already validates, so boot-time validation and
//   runtime key loading can never drift apart. getMasterKey() reads exactly
//   this variable and throws a coded error with code MISSING_MASTER_KEY when
//   it is absent or blank, per its typed contract in types/security.ts. the
//   failure message names the variable and never echoes its value; the key
//   value lives only in process memory.
// - the ciphertext is aes-256-gcm via node's built-in crypto (no new
//   dependency). a fresh random 96-bit iv is generated per encryption and is
//   never reused. the gcm auth tag is embedded tag-prefixed inside the
//   base64 encryptedPrivateKey blob, because EncryptedKeyRecord has no
//   separate tag field; decryption splits the tag off and verifies it
//   unconditionally, so any tampering with ciphertext or iv fails closed as
//   KEY_DECRYPTION_FAILED.
// - the master key string is any non-empty secret; a 32-byte aes-256 key is
//   derived from it with one sha-256 pass. the env secret is assumed high
//   entropy (an operator supplied random string), so the cheap derivation is
//   sufficient here; the cli's passphrase file uses scrypt because a
//   passphrase is low entropy and that is a different system.
// - every decryption failure path (wrong master key, tampered ciphertext,
//   tampered iv, truncated or malformed record, unexpected algorithm)
//   returns a typed Result failure with code KEY_DECRYPTION_FAILED. it never
//   throws and never returns garbage. no failure message contains the master
//   key, the private key, or the ciphertext.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { OpenRepErrorCode } from "./types/errors.js";
import { failure, ok, type Result } from "./types/errors.js";
import type { AgentId } from "./types/identity.js";
import type { EncryptedKeyRecord } from "./types/security.js";

// canonical env var, shared with loadEnvConfig(). exported so tests and the
// eventual web app wiring read the same name from one place.
export const MASTER_KEY_ENV_VAR = "OPENREP_MASTER_ENCRYPTION_KEY";

// the only algorithm this module produces or accepts. a record claiming any
// other algorithm is rejected at decrypt time.
export const ENCRYPTED_KEY_ALGORITHM = "aes-256-gcm";

// gcm iv size in bytes and auth tag size in bytes.
const IV_BYTES = 12;
const TAG_BYTES = 16;

// throws the typed coded error the getMasterKey contract promises. plain
// Error with a machine readable code property, the same shape the storage
// layer uses; never carries the key value.
function codedError(code: OpenRepErrorCode, message: string): Error {
  const err = new Error(message);
  (err as { code?: OpenRepErrorCode }).code = code;
  return err;
}

// loads the server master key from the environment. throws a coded
// MISSING_MASTER_KEY error when the variable is absent or whitespace only:
// an empty or default key is a fail-closed event, never a silent proceed.
// the env param defaults to process.env but can be injected for tests and
// for callers that already loaded the env elsewhere. the key value itself
// is never logged and never included in the error message.
export function getMasterKey(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[MASTER_KEY_ENV_VAR];
  const masterKey = raw === undefined ? undefined : raw.trim();
  if (masterKey === undefined || masterKey.length === 0) {
    throw codedError("MISSING_MASTER_KEY", `${MASTER_KEY_ENV_VAR} is required`);
  }
  return masterKey;
}

// derives the 32-byte aes-256 key from the env secret. the env secret is
// high entropy by design (see module header), so a single sha-256 pass is
// the documented derivation; never the raw secret passed to createCipheriv.
function deriveKey(masterKey: string): Buffer {
  return createHash("sha256").update(masterKey, "utf8").digest();
}

// encrypts an agent private key into an EncryptedKeyRecord envelope under
// the master key. takes agentId because the record type carries it; the
// agentId is informational record metadata, not covered by the gcm tag (the
// store keys entries by agentId separately). iv is fresh and random per
// call. returns the record directly; encryption of a well formed string
// cannot fail.
export function encryptPrivateKey(privateKey: string, masterKey: string, agentId: AgentId): EncryptedKeyRecord {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(masterKey), iv);
  const ciphertext = Buffer.concat([cipher.update(privateKey, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([tag, ciphertext]);
  return {
    agentId,
    encryptedPrivateKey: blob.toString("base64"),
    iv: iv.toString("base64"),
    algorithm: ENCRYPTED_KEY_ALGORITHM,
    createdAt: new Date().toISOString(),
  };
}

// a record parses when all five fields are present with the right types and
// the base64 fields are strict base64 (round trips exactly, so truncated or
// garbage blobs are rejected before any crypto runs).
function parseRecord(record: EncryptedKeyRecord): { algorithm: string; iv: Buffer; blob: Buffer } | null {
  if (record === null || typeof record !== "object") return null;
  const { algorithm, iv, encryptedPrivateKey } = record;
  if (typeof algorithm !== "string" || typeof iv !== "string" || typeof encryptedPrivateKey !== "string") return null;
  if (typeof record.agentId !== "string" || typeof record.createdAt !== "string") return null;
  if (!isStrictBase64(iv)) return null;
  if (!isStrictBase64(encryptedPrivateKey)) return null;
  const ivBuf = Buffer.from(iv, "base64");
  const blob = Buffer.from(encryptedPrivateKey, "base64");
  if (ivBuf.length !== IV_BYTES) return null;
  // tag-prefixed layout: at least the tag plus one ciphertext byte.
  if (blob.length < TAG_BYTES + 1) return null;
  return { algorithm, iv: ivBuf, blob };
}

function isStrictBase64(value: string): boolean {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value;
}

// decrypts an EncryptedKeyRecord back to the private key, in memory only.
// every violation is a typed KEY_DECRYPTION_FAILED failure: wrong master
// key, tampered ciphertext or iv (the gcm auth tag catches both), a record
// with an unexpected algorithm, or a malformed/truncated record. never
// throws. the failure message is intentionally generic so no key material
// or ciphertext can leak into logs.
export function decryptPrivateKey(record: EncryptedKeyRecord, masterKey: string): Result<string> {
  const parsed = parseRecord(record);
  if (parsed === null || parsed.algorithm !== ENCRYPTED_KEY_ALGORITHM) {
    return failure("KEY_DECRYPTION_FAILED", "failed to decrypt private key: the record is malformed or the master key is wrong");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(masterKey), parsed.iv);
    decipher.setAuthTag(parsed.blob.subarray(0, TAG_BYTES));
    const ciphertext = parsed.blob.subarray(TAG_BYTES);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return ok(plaintext.toString("utf8"));
  } catch {
    // gcm final() throws on any authentication failure; wrong key and
    // tampering land here. nothing from the exception is propagated.
    return failure("KEY_DECRYPTION_FAILED", "failed to decrypt private key: the record is malformed or the master key is wrong");
  }
}