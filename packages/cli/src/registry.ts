// cli-side registry of source adapters for `openrep ingest`. the sdk's
// ingest() takes a SourceAdapter dependency; this registry is where the cli
// resolves one by source name.
//
// the registry is intentionally EMPTY in this pass. no real external source
// adapter has shipped yet: the marketplace app (apps/marketplace) is a
// separate, later build, and its openrep-side adapter is still to come.
// until one lands here, `openrep ingest --source <name>` fails honestly with
// UNKNOWN_SOURCE: "no adapter registered for source <name>", never a
// placeholder adapter pretending to understand a platform it does not.

import type { SourceAdapter } from "@openrep/sdk";

const adapters: Record<string, SourceAdapter> = {};

export function getSourceAdapter(sourceName: string): SourceAdapter | null {
  return adapters[sourceName] ?? null;
}

// future adapters are registered here as real modules, e.g.
//   import { marketplaceAdapter } from "./adapters/marketplace.js";
//   adapters["marketplace"] = marketplaceAdapter;