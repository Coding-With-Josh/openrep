import { describe, expect, it } from "vitest";
import { MAX_CANONICAL_DEPTH, canonicalize } from "../src/index.js";

function nested(depth: number): unknown {
  let value: unknown = "leaf";
  for (let i = 0; i < depth; i++) value = { child: value };
  return value;
}

describe("canonicalize guards", () => {
  it("serializes flat manifest-shaped input deterministically (regression canary)", () => {
    const a = canonicalize({ name: "quiet-pig-blue.agent", nested: { b: 1, a: 2 }, flags: [true, null, "z"] });
    const b = canonicalize({ flags: [true, null, "z"], nested: { a: 2, b: 1 }, name: "quiet-pig-blue.agent" });
    expect(a).toBe(b);
    expect(a).toBe('{"flags":[true,null,"z"],"name":"quiet-pig-blue.agent","nested":{"a":2,"b":1}}');
  });

  it("rejects a direct circular reference in an object", () => {
    const cyclic: Record<string, unknown> = { name: "x" };
    cyclic.self = cyclic;
    expect(() => canonicalize(cyclic)).toThrow(/circular reference detected/);
  });

  it("rejects a two-object cycle", () => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    a.b = b;
    b.a = a;
    expect(() => canonicalize(a)).toThrow(/circular reference detected/);
  });

  it("rejects a self-appending array", () => {
    const arr: unknown[] = [1, 2];
    arr.push(arr);
    expect(() => canonicalize(arr)).toThrow(/circular reference detected/);
  });

  it("accepts the same object referenced from two siblings (cycle-accurate, not a duplicate rejector)", () => {
    const shared = { v: 1 };
    const value = { x: shared, y: shared };
    expect(canonicalize(value)).toBe('{"x":{"v":1},"y":{"v":1}}');
  });

  it("allows nesting up to MAX_CANONICAL_DEPTH and rejects one level beyond it", () => {
    expect(canonicalize(nested(MAX_CANONICAL_DEPTH))).toContain("leaf");
    expect(() => canonicalize(nested(MAX_CANONICAL_DEPTH + 1))).toThrow(/exceeds maximum depth of 6/);
  });

  it("rejects unsupported value types with a clear error", () => {
    expect(() => canonicalize(undefined)).toThrow(/unsupported value type/);
    expect(() => canonicalize(() => 1)).toThrow(/unsupported value type/);
  });

  it("rejects non-finite numbers so signed bytes stay portable", () => {
    expect(() => canonicalize({ n: Number.NaN })).toThrow(/non-finite number/);
    expect(() => canonicalize({ n: Infinity })).toThrow(/non-finite number/);
  });
});