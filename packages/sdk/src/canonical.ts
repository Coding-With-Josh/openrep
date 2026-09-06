// deterministic canonical serialization for signing. recursive, object keys
// sorted, no whitespace, so the same logical object always serializes to the
// exact same bytes regardless of key insertion order or formatting. this is
// what makes a signature portable: the signer and the verifier must hash the
// same bytes, and only a canonical form guarantees that across implementations.
// used for the manifest signature now, and for attestation content hashes.
//
// guards, added because attestation toolsUsed input is caller-shaped
// arbitrary data rather than the flat known-shape manifest fields:
// - circular references are rejected with a clear error instead of letting
//   the recursion hang or crash. detection uses an ancestor set along the
//   current path, which is cycle-accurate: the same object referenced from
//   two sibling fields is legal and serializes twice, a genuine cycle is not.
// - nesting depth is bounded at MAX_CANONICAL_DEPTH so a crafted deeply
//   nested structure cannot drive unbounded recursion.
export const MAX_CANONICAL_DEPTH = 6;

export function canonicalize(value: unknown): string {
  return canonicalizeInner(value, new Set<object>(), 0);
}

function canonicalizeInner(value: unknown, ancestors: Set<object>, depth: number): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    // non finite numbers would serialize differently across json parsers,
    // so they are rejected as a programming error instead of silently
    // producing a non portable signature.
    if (!Number.isFinite(value)) throw new Error("canonicalize: non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    if (depth >= MAX_CANONICAL_DEPTH) {
      throw new Error(`canonicalize: exceeds maximum depth of ${MAX_CANONICAL_DEPTH}`);
    }
    if (ancestors.has(value)) throw new Error("canonicalize: circular reference detected");
    ancestors.add(value);
    try {
      return "[" + value.map((item) => canonicalizeInner(item, ancestors, depth + 1)).join(",") + "]";
    } finally {
      // remove on the way out so a sibling reference to the same object is
      // legal, only a genuine cycle (revisiting an ancestor) is rejected.
      ancestors.delete(value);
    }
  }
  if (typeof value === "object") {
    if (depth >= MAX_CANONICAL_DEPTH) {
      throw new Error(`canonicalize: exceeds maximum depth of ${MAX_CANONICAL_DEPTH}`);
    }
    if (ancestors.has(value)) throw new Error("canonicalize: circular reference detected");
    ancestors.add(value);
    try {
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalizeInner(record[k], ancestors, depth + 1)).join(",") + "}";
    } finally {
      ancestors.delete(value);
    }
  }
  throw new Error("canonicalize: unsupported value type");
}