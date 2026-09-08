import { describe, expect, it } from "vitest";
import {
  ADJECTIVES,
  COLORS,
  NOUNS,
  generateName,
  generateNameBatch,
} from "../src/index.js";

describe("generateName", () => {
  it("produces the documented adjective-noun-color.agent shape", () => {
    for (let i = 0; i < 50; i++) {
      const name = generateName();
      expect(name).toMatch(/^[a-z]+-[a-z]+-[a-z]+\.agent$/);
      const [adjective, noun, color] = name.replace(/\.agent$/, "").split("-");
      expect(ADJECTIVES).toContain(adjective);
      expect(NOUNS).toContain(noun);
      expect(COLORS).toContain(color);
    }
  });
});

describe("generateNameBatch", () => {
  it("returns exactly count distinct names", () => {
    const batch = generateNameBatch(8);
    expect(batch).toHaveLength(8);
    expect(new Set(batch).size).toBe(8);
  });

  it("never repeats a word within the batch", () => {
    const batch = generateNameBatch(Math.min(ADJECTIVES.length, NOUNS.length, COLORS.length));
    const words = batch.map((name) => name.replace(/\.agent$/, "").split("-"));
    const adjectives = words.map((w) => w[0]);
    const nouns = words.map((w) => w[1]);
    const colors = words.map((w) => w[2]);
    expect(new Set(adjectives).size).toBe(adjectives.length);
    expect(new Set(nouns).size).toBe(nouns.length);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("only draws words from the exported lists", () => {
    for (const name of generateNameBatch(12)) {
      const [adjective, noun, color] = name.replace(/\.agent$/, "").split("-");
      expect(ADJECTIVES).toContain(adjective);
      expect(NOUNS).toContain(noun);
      expect(COLORS).toContain(color);
    }
  });

  it("throws on out-of-range counts", () => {
    expect(() => generateNameBatch(0)).toThrow(RangeError);
    expect(() => generateNameBatch(1.5)).toThrow(RangeError);
    const max = Math.min(ADJECTIVES.length, NOUNS.length, COLORS.length);
    expect(() => generateNameBatch(max + 1)).toThrow(RangeError);
  });
});