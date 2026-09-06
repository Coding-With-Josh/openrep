// direct tests for the structural tool-argument validator. this is the gate
// that stands between model-generated arguments and a real tool
// implementation, so its behavior on both valid and crafted input matters.
import { describe, expect, it } from "vitest";
import { validateAgainstSchema } from "../src/index.js";

const objectSchema = {
  type: "object",
  properties: {
    a: { type: "number" },
    b: { type: "number" },
  },
  required: ["a", "b"],
  additionalProperties: false,
};

describe("validateAgainstSchema", () => {
  it("accepts a valid object", () => {
    expect(validateAgainstSchema({ a: 1, b: 2 }, objectSchema)).toEqual({ valid: true });
  });

  it("rejects a missing required property", () => {
    expect(validateAgainstSchema({ a: 1 }, objectSchema)).toEqual({
      valid: false,
      reason: "missing required property b",
    });
  });

  it("rejects an extra property when additionalProperties is false", () => {
    expect(validateAgainstSchema({ a: 1, b: 2, c: 3 }, objectSchema)).toEqual({
      valid: false,
      reason: "unexpected property c",
    });
  });

  it("rejects a wrong-typed property", () => {
    expect(validateAgainstSchema({ a: "one", b: 2 }, objectSchema)).toEqual({
      valid: false,
      reason: "property a: expected a number",
    });
  });

  it("rejects a non-object top level", () => {
    expect(validateAgainstSchema("nope", objectSchema)).toEqual({ valid: false, reason: "expected an object" });
  });

  it("validates nested arrays", () => {
    const schema = { type: "object", properties: { nums: { type: "array", items: { type: "number" } } }, required: ["nums"], additionalProperties: false };
    expect(validateAgainstSchema({ nums: [1, 2, 3] }, schema)).toEqual({ valid: true });
    expect(validateAgainstSchema({ nums: [1, "two"] }, schema)).toEqual({
      valid: false,
      reason: "property nums: array item: expected a number",
    });
  });

  it("applies minLength/maxLength on strings", () => {
    const schema = { type: "object", properties: { s: { type: "string", minLength: 2, maxLength: 4 } }, required: ["s"], additionalProperties: false };
    expect(validateAgainstSchema({ s: "ab" }, schema)).toEqual({ valid: true });
    expect(validateAgainstSchema({ s: "a" }, schema)).toEqual({ valid: false, reason: "property s: string shorter than minLength 2" });
    expect(validateAgainstSchema({ s: "abcde" }, schema)).toEqual({ valid: false, reason: "property s: string longer than maxLength 4" });
  });

  it("rejects NaN numbers as non-numbers", () => {
    expect(validateAgainstSchema({ a: Number.NaN, b: 2 }, objectSchema)).toEqual({ valid: false, reason: "property a: expected a number" });
  });

  it("rejects unsupported schema types", () => {
    const schema = { type: "object", properties: { x: { type: "date" } }, required: ["x"] };
    expect(validateAgainstSchema({ x: 1 }, schema)).toEqual({ valid: false, reason: "property x: unsupported schema type date" });
  });
});