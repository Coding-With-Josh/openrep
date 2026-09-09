// tiny cross-command helpers: turning sdk failures and custody failures into
// the cli's "<CODE>: <message>" stderr contract.

import type { OpenRepError } from "@openrepso/sdk";

import { cliError, fail } from "../cli-error.js";
import { CustodyError } from "../custody/types.js";

export function failSdkError(error: OpenRepError): void {
  fail(cliError(error.code, error.message));
}

export function failSdkCode(code: string, message: string): void {
  fail(cliError(code, message));
}

// custody failures are cli-side (the sdk never sees them); normalize them to
// the same stderr contract so a keychain outage reads like any other failure.
export function handleCustodyError(err: unknown): boolean {
  if (err instanceof CustodyError) {
    fail(cliError(err.code, err.message));
    return true;
  }
  return false;
}