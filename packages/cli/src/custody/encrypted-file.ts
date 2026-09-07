// encrypted-file fallback store: ~/.openrep/credentials.enc, aes-256-gcm
// under a key derived from a user-supplied passphrase via scrypt. the
// derivation secret is the passphrase, never a key stored next to the file,
// so the fallback keeps a real secret at its root (technical.md, cli key
// custody policy). posix permissions are enforced to owner read/write only
// as a second layer of defense, and reads fail closed on any violation.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { KeyStore } from "./types.js";

const VERSION = 1;
const KEY_LENGTH = 32;
const SCRYPT_N = 16_384; // node's default cost, memory hard by design
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const FILE_MODE = 0o600;

interface Envelope {
  version: number;
  salt: string; // base64
  iv: string; // base64, 12 bytes for aes-256-gcm
  tag: string; // base64, 16 bytes
  data: string; // base64 ciphertext of a json object: { [account]: secret }
}

export class EncryptedFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptedFileError";
  }
}

function b64(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64");
}

function parseEnvelope(text: string): Envelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new EncryptedFileError("credentials file is not valid json; refusing to guess");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Envelope).version !== VERSION ||
    typeof (parsed as Envelope).salt !== "string" ||
    typeof (parsed as Envelope).iv !== "string" ||
    typeof (parsed as Envelope).tag !== "string" ||
    typeof (parsed as Envelope).data !== "string"
  ) {
    throw new EncryptedFileError("credentials file has an unsupported or corrupt format");
  }
  return parsed as Envelope;
}

function bindingKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
}

// fail closed on loose permissions: the encrypted file is only as strong as
// its key, but the key is a passphrase, so group/world readability would
// hand an offline brute-force target to anyone who can read the file.
function assertOwnerOnlyPerms(filePath: string): void {
  if (process.platform === "win32") return; // no posix modes on windows
  const mode = statSync(filePath).mode;
  if ((mode & 0o077) !== 0) {
    throw new EncryptedFileError(
      `credentials file ${filePath} is readable by group/others (mode ${(mode & 0o777).toString(8)}); chmod 600 it and try again`,
    );
  }
}

export interface EncryptedFileStoreOptions {
  // passphrase provider instead of the interactive masked prompt; used by
  // tests and by headless fallback flows where stdin is not a tty.
  getPassphrase?: () => Promise<string>;
}

export function createEncryptedFileStore(
  filePath: string,
  getPassphrase: () => Promise<string>,
): KeyStore {
  // the passphrase provider may be consulted several times in one operation
  // (set decrypts the existing file, then encrypts the merged set). the
  // store remembers the first answer so the user is prompted exactly once
  // per cli invocation. fail-closed is unaffected: a wrong passphrase still
  // fails every decrypt inside this store's lifetime.
  let cachedPassphrase: string | null = null;
  async function passphrase(): Promise<string> {
    if (cachedPassphrase !== null) return cachedPassphrase;
    cachedPassphrase = await getPassphrase();
    return cachedPassphrase;
  }

  return {
    kind: "encrypted-file",

    async get(account: string): Promise<string | null> {
      if (!existsSync(filePath)) return null; // nothing stored yet is a miss, not an error
      assertOwnerOnlyPerms(filePath);

      let envelope: Envelope;
      try {
        envelope = parseEnvelope(readFileSync(filePath, "utf8"));
      } catch (err) {
        if (err instanceof EncryptedFileError) throw err;
        throw new EncryptedFileError(`could not read ${filePath}: ${(err as Error).message}`);
      }

      const key = bindingKey(await passphrase(), Buffer.from(envelope.salt, "base64"));
      let plaintext: Buffer;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
        decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
        plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]);
      } catch {
        // distinct failure buckets: the auth tag failed (wrong passphrase or
        // tampered ciphertext) vs unreadable envelope. both fail closed.
        throw new EncryptedFileError(
          "could not decrypt the credentials file: wrong passphrase or the file was tampered with",
        );
      }

      let records: unknown;
      try {
        records = JSON.parse(plaintext.toString("utf8"));
      } catch {
        throw new EncryptedFileError("decrypted credentials are not valid json; refusing to use them");
      }
      if (typeof records !== "object" || records === null || Array.isArray(records)) {
        throw new EncryptedFileError("decrypted credentials have an unsupported shape");
      }
      const value = (records as Record<string, unknown>)[account];
      return typeof value === "string" ? value : null;
    },

    async set(account: string, secret: string): Promise<void> {
      // read-modify-write: load existing records first so multiple agents
      // share one credentials file. a file that cannot be decrypted is a
      // hard failure (never silently overwrite a valid store with a fresh one).
      const existing: Record<string, string> = {};
      if (existsSync(filePath)) {
        assertOwnerOnlyPerms(filePath);
        const envelope = parseEnvelope(readFileSync(filePath, "utf8"));
        const key = bindingKey(await passphrase(), Buffer.from(envelope.salt, "base64"));
        let plaintext: Buffer;
        try {
          const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
          decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
          plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]);
        } catch {
          throw new EncryptedFileError(
            "could not decrypt the existing credentials file: wrong passphrase or tampered file; not overwriting it",
          );
        }
        try {
          const parsed = JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>;
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === "string") existing[k] = v;
          }
        } catch {
          throw new EncryptedFileError("decrypted credentials are corrupt; refusing to overwrite");
        }
      }

      existing[account] = secret;

      const salt = randomBytes(16);
      const iv = randomBytes(12);
      const key = bindingKey(await passphrase(), salt);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(existing), "utf8"), cipher.final()]);
      const envelope: Envelope = {
        version: VERSION,
        salt: b64(salt),
        iv: b64(iv),
        tag: b64(cipher.getAuthTag()),
        data: b64(ciphertext),
      };

      // create with 0600 mode directly, then force it again after the write
      // so the secret never sits on disk under a wider default mode.
      writeFileSync(filePath, JSON.stringify(envelope), { mode: FILE_MODE });
      chmodSync(filePath, FILE_MODE);
      void dirname(filePath); // parent directory creation is the caller's job
    },
  };
}