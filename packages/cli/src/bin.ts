#!/usr/bin/env node
// bin wrapper: the only module with a top-level side effect. importing
// @openrep/cli (for in-process tests) pulls in main() without running it.

import { main } from "./index.js";

main(process.argv).then((code) => {
  process.exitCode = code;
});