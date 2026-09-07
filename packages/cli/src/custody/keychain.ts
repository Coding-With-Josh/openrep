// os-level secure keychain access, invoking the platform's native credential
// tool directly as a child process. no third-party keychain library,
// matching the project's dependency-light decision.
//
//   darwin:  `security` (macos keychain)
//   linux:   `secret-tool` (libsecret / secret service)
//   win32:   `powershell.exe` running an inline c# snippet loaded via
//            Add-Type, p/invoking advapi32's CredWrite/CredRead/CredDelete
//            to reach the windows credential manager directly. the secret
//            rides stdin (never argv); the only value interpolated into the
//            generated script is the credential target, re-validated to the
//            exact account shape before it is allowed near the script.
//
// all invocations use execFile with argument arrays (never a shell), and
// every account name is built only from validated 64-char lowercase hex
// public keys, so no attacker-controlled string ever reaches argv.

import { execFile } from "node:child_process";
import type { KeyStore } from "./types.js";

const SERVICE_NAME = "openrep";

export interface KeychainStoreOptions {
  // path to an alternate keychain database, used by tests against a
  // throwaway keychain instead of the user's login keychain. absent in
  // normal use, where the default search list applies.
  keychainPath?: string;
  // win32-only test seam: replace the real powershell.exe child process with
  // a fake so the windows credential manager store can be tested without a
  // windows machine. absent in production (Phase-3 vector IV5).
  executor?: ExecutorFn;
}

export class KeychainUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeychainUnavailableError";
  }
}

export interface ExecResult {
  stdout: string;
  exitCode: number | null;
}

// child-process invocation seam, matching execFileP's shape below.
export type ExecutorFn = (bin: string, args: string[], input?: string) => Promise<ExecResult>;

function execFileP(bin: string, args: string[], input?: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { encoding: "utf8" }, (err, stdout, stderr) => {
      const exitCode = err === null ? 0 : typeof err.code === "number" ? err.code : null;
      if (err !== null) {
        const detail = (stderr || err.message || "").trim();
        reject(Object.assign(new Error(detail || "unknown error"), { exitCode }));
        return;
      }
      resolve({ stdout, exitCode });
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

const NOT_FOUND_EXIT_CODE = 44; // security: "The specified item could not be found."

// --- win32: windows credential manager via powershell.exe + inline c# --------
//
// cmdkey cannot read a secret back out, so the store shells out to
// powershell.exe running an Add-Type c# snippet with p/invoke declarations
// for advapi32's CredWrite/CredRead/CredDelete: real credential manager
// access, entries visible in windows' own credential manager control panel,
// the same trust boundary the darwin and linux paths already use.
//
// the whole script is passed as a single -EncodedCommand argument (base64 of
// utf-16le), which removes every shell quoting/escaping question in one step.
// the only value interpolated into the script is the credential target, and
// WIN32_ACCOUNT_RE re-validates it to the exact public-key account shape
// before it can influence the script (Phase-3 vector IV1). the secret itself
// goes over stdin, never argv, so it cannot appear in another process's
// command-line listing (Phase-3 vector IV2).

const WIN32_POWERSHELL = "powershell.exe";
const WIN32_NOT_FOUND = "NOT_FOUND";
// accounts are exactly "<64 lowercase hex>.identity" or ".owner" (types.ts).
const WIN32_ACCOUNT_RE = /^[0-9a-f]{64}\.(identity|owner)$/;

const WIN32_CS = `
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class OpenRepCred
{
    private const int CRED_TYPE_GENERIC = 1;
    private const uint CRED_PERSIST_ENTERPRISE = 2;
    private const int ERROR_NOT_FOUND = 1168;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct CREDENTIAL
    {
        public uint Flags;
        public int Type;
        public IntPtr TargetName;
        public IntPtr Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public IntPtr TargetAlias;
        public IntPtr UserName;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite([In] ref CREDENTIAL credential, uint flags);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, int type, int flags, out IntPtr credential);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDelete(string target, int type, int flags);

    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr buffer);

    public static bool Write(string target, string secret)
    {
        byte[] blobBytes = Encoding.UTF8.GetBytes(secret);
        IntPtr targetPtr = Marshal.StringToCoTaskMemUni(target);
        IntPtr blobPtr = Marshal.AllocCoTaskMem(blobBytes.Length);
        try
        {
            Marshal.Copy(blobBytes, 0, blobPtr, blobBytes.Length);
            CREDENTIAL cred = new CREDENTIAL();
            cred.Type = CRED_TYPE_GENERIC;
            cred.TargetName = targetPtr;
            cred.CredentialBlob = blobPtr;
            cred.CredentialBlobSize = (uint)blobBytes.Length;
            cred.Persist = CRED_PERSIST_ENTERPRISE;
            return CredWrite(ref cred, 0);
        }
        finally
        {
            Marshal.FreeCoTaskMem(targetPtr);
            Marshal.FreeCoTaskMem(blobPtr);
        }
    }

    public static string Read(string target)
    {
        IntPtr pCred;
        if (!CredRead(target, CRED_TYPE_GENERIC, 0, out pCred))
        {
            int lastError = Marshal.GetLastWin32Error();
            return lastError == ERROR_NOT_FOUND ? "NOT_FOUND" : ("ERROR:" + lastError.ToString());
        }
        try
        {
            CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(pCred, typeof(CREDENTIAL));
            if (cred.CredentialBlob == IntPtr.Zero || cred.CredentialBlobSize == 0) return "ERROR:EMPTY";
            byte[] blobBytes = new byte[cred.CredentialBlobSize];
            Marshal.Copy(cred.CredentialBlob, blobBytes, 0, blobBytes.Length);
            return Encoding.UTF8.GetString(blobBytes);
        }
        finally
        {
            CredFree(pCred);
        }
    }

    public static bool Delete(string target)
    {
        return CredDelete(target, CRED_TYPE_GENERIC, 0);
    }
}
`;

const WIN32_SCRIPT_HEAD = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
${WIN32_CS}
'@
`;

// builds the one-shot powershell script for an operation, interpolating only
// the already-validated credential target, then encodes it for
// -EncodedCommand (base64 of utf-16le). the secret is never part of this
// string: set reads it from stdin inside the script.
function win32EncodedScript(kind: "get" | "set", target: string): string {
  const op =
    kind === "get"
      ? [
          "$result = [OpenRepCred]::Read($target)",
          "if ($result -eq 'NOT_FOUND') { [Console]::Out.WriteLine('NOT_FOUND') }",
          "elseif ($result.StartsWith('ERROR')) { [Console]::Error.WriteLine($result); exit 1 }",
          "else { [Console]::Out.WriteLine($result) }",
        ].join("\n")
      : [
          "$secret = [Console]::In.ReadToEnd().Trim()",
          "if (-not [OpenRepCred]::Write($target, $secret)) { [Console]::Error.WriteLine('CredWrite failed'); exit 1 }",
        ].join("\n");
  const script = `${WIN32_SCRIPT_HEAD}$target = "openrep/${target}"\n${op}\n`;
  return Buffer.from(script, "utf16le").toString("base64");
}

function win32Args(kind: "get" | "set", target: string): string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    win32EncodedScript(kind, target),
  ];
}

export function createKeychainStore(options: KeychainStoreOptions = {}): KeyStore {
  const { keychainPath } = options;

  return {
    kind: "keychain",

    async get(account: string): Promise<string | null> {
      if (process.platform === "darwin") {
        const args = ["find-generic-password", "-a", account, "-s", SERVICE_NAME, "-w"];
        if (keychainPath !== undefined) args.push(keychainPath);
        try {
          const { stdout } = await execFileP("security", args);
          return stdout.replace(/\n$/, "");
        } catch (err) {
          if ((err as { exitCode?: number | null }).exitCode === NOT_FOUND_EXIT_CODE) {
            // a normal miss: the entry was never stored, not a broken tool.
            return null;
          }
          throw new KeychainUnavailableError(`macos keychain unavailable: ${(err as Error).message}`);
        }
      }

      if (process.platform === "linux") {
        try {
          const { stdout } = await execFileP("secret-tool", ["lookup", "service", SERVICE_NAME, "account", account]);
          return stdout.length > 0 ? stdout.replace(/\n$/, "") : null;
        } catch (err) {
          throw new KeychainUnavailableError(`secret service unavailable: ${(err as Error).message}`);
        }
      }

      if (process.platform === "win32") {
        const exec = options.executor ?? execFileP;
        if (!WIN32_ACCOUNT_RE.test(account)) {
          // the account is interpolated into the powershell script; anything
          // other than the exact validated shape is refused before it can
          // influence the child process (Phase-3 vector IV1).
          throw new KeychainUnavailableError(
            `windows credential manager: refusing malformed account name ${account}`,
          );
        }
        try {
          const { stdout, exitCode } = await exec(WIN32_POWERSHELL, win32Args("get", account));
          if (exitCode !== 0) {
            throw new KeychainUnavailableError(
              `windows credential manager get failed with exit code ${exitCode}`,
            );
          }
          // powershell may prepend a utf-8 bom and always appends a newline.
          const out = stdout.replace(/^\uFEFF/, "").replace(/\r?\n$/, "");
          if (out === WIN32_NOT_FOUND) return null; // normal miss, like darwin exit 44
          if (out.length === 0) {
            // never return an empty string as a key, and never call a blank
            // response a miss (Phase-3 vector IV3).
            throw new KeychainUnavailableError("windows credential manager returned an empty response");
          }
          return out;
        } catch (err) {
          if (err instanceof KeychainUnavailableError) throw err;
          // covers a missing powershell.exe (ENOENT), execution-policy blocks,
          // and every spawned-process failure: loud skip, never a crash.
          throw new KeychainUnavailableError(`windows credential manager unavailable: ${(err as Error).message}`);
        }
      }

      throw new KeychainUnavailableError(
        `os keychain is not supported on ${process.platform}; use OPENREP_SIGNING_KEY or the encrypted file fallback`,
      );
    },

    async set(account: string, secret: string): Promise<void> {
      if (process.platform === "darwin") {
        // note: the secret rides in argv of the `security` child process on
        // macos (the native tool reads it there). the agent's own process
        // still owns the key in memory, and the keychain is the storage
        // device; this is the standard `security` usage pattern.
        const args = ["add-generic-password", "-a", account, "-s", SERVICE_NAME, "-w", secret, "-U"];
        if (keychainPath !== undefined) args.push(keychainPath);
        try {
          await execFileP("security", args);
          return;
        } catch (err) {
          throw new KeychainUnavailableError(`macos keychain unavailable: ${(err as Error).message}`);
        }
      }

      if (process.platform === "linux") {
        const args = ["store", "--label=openrep", "service", SERVICE_NAME, "account", account];
        try {
          // secret-tool reads the password from stdin, keeping it out of argv.
          await execFileP("secret-tool", args, secret);
          return;
        } catch (err) {
          throw new KeychainUnavailableError(`secret service unavailable: ${(err as Error).message}`);
        }
      }

      if (process.platform === "win32") {
        const exec = options.executor ?? execFileP;
        if (!WIN32_ACCOUNT_RE.test(account)) {
          throw new KeychainUnavailableError(
            `windows credential manager: refusing malformed account name ${account}`,
          );
        }
        try {
          // the secret rides stdin, never argv: command-line arguments are
          // visible to other processes via process listings (Phase-3 vector
          // IV2).
          const { exitCode } = await exec(WIN32_POWERSHELL, win32Args("set", account), secret);
          if (exitCode !== 0) {
            throw new KeychainUnavailableError(
              `windows credential manager set failed with exit code ${exitCode}`,
            );
          }
          return;
        } catch (err) {
          if (err instanceof KeychainUnavailableError) throw err;
          throw new KeychainUnavailableError(`windows credential manager unavailable: ${(err as Error).message}`);
        }
      }

      throw new KeychainUnavailableError(
        `os keychain is not supported on ${process.platform}; use OPENREP_SIGNING_KEY or the encrypted file fallback`,
      );
    },
  };
}