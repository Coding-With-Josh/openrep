// cli-side errors and exit-code helpers. every command failure prints a
// single human readable line to stderr in the form "<CODE>: <message>" and
// sets process.exitCode = 1, so failures are scriptable and detectable
// without dumping raw stack traces or key material.

export interface CliError {
  code: string;
  message: string;
}

export function cliError(code: string, message: string): CliError {
  return { code, message };
}

// prints an sdk-typed failure or a cli-local error, sets the exit code.
export function fail(error: CliError): CliError {
  process.stderr.write(`${error.code}: ${error.message}\n`);
  process.exitCode = 1;
  return error;
}

export function failWithSdkCode(code: string, message: string): CliError {
  return fail(cliError(code, message));
}