// masked passphrase prompt using node's own readline/tty facilities, no new
// dependency. keystrokes are never echoed to the terminal.

import readline from "node:readline";

export function readPassphraseFromTerminal(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdout = process.stderr; // prompts go to stderr so stdout stays parseable
    const rl = readline.createInterface({ input: process.stdin, output: stdout, terminal: true });

    // the terminal normally echoes typed characters back through the output
    // stream; intercept writes and replace echoed input with a mask.
    // _writeToOutput is an internal node API: the cast is required because
    // @types/node does not surface it on the public Interface type.
    const rlInternal = rl as unknown as { _writeToOutput: (str: string) => void };
    const originalWrite = rlInternal._writeToOutput.bind(rl);
    rlInternal._writeToOutput = (str: string) => {
      if (str.includes("\n") || str.includes("\r") || str.includes("\x1b")) {
        originalWrite(str);
      } else {
        originalWrite("*");
      }
    };

    stdout.write(prompt);
    rl.once("line", (line) => {
      rl.write("\n");
      rl.close();
      resolve(line.trim());
    });
    rl.once("error", (err) => {
      rl.close();
      reject(err);
    });
  });
}