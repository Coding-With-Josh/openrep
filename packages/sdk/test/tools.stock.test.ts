// tests for the stock tool registry. network-backed tools are exercised
// through their pure helpers (html strip, truncation, arxiv feed parsing,
// calculator evaluation); the registry assembly is checked for the
// definition/implementation invariant that the run loop depends on.
import { describe, expect, it } from "vitest";
import { stripHtmlToText, truncate } from "../src/tools/fetch-tools.js";
import { parseArxivFeed } from "../src/tools/knowledge.js";
import { evaluate } from "../src/tools/calculator.js";
import { createStockToolset } from "../src/tools/index.js";
import { createSqliteStorage } from "../src/storage/sqlite.js";

const storage = createSqliteStorage(":memory:");

describe("stripHtmlToText", () => {
  it("removes tags and decodes common entities", () => {
    expect(stripHtmlToText("<p>hello &amp; goodbye</p>")).toBe("hello & goodbye");
    expect(stripHtmlToText("<script>alert(1)</script><p>safe</p>")).toBe("safe");
    expect(stripHtmlToText("<div>a<span>b</span>c</div>")).toBe("abc");
  });
});

describe("truncate", () => {
  it("shortens with an explicit marker", () => {
    expect(truncate("abcd", 3)).toBe("abc... (truncated)");
    expect(truncate("ab", 3)).toBe("ab");
  });
});

const SAMPLE_ARXIV_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2501.00001v1</id>
    <title>Example Paper</title>
    <summary>This is the <i>abstract</i> of the paper.</summary>
    <name>Alice Example</name><name>Bob Example</name>
    <published>2025-01-01T00:00:00Z</published>
    <updated>2025-01-02T00:00:00Z</updated>
    <category term="cs.AI"/><category term="cs.CL"/>
  </entry>
</feed>`;

describe("parseArxivFeed", () => {
  it("parses the top-level fields and multiple authors", () => {
    const entries = parseArxivFeed(SAMPLE_ARXIV_FEED);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.id).toBe("http://arxiv.org/abs/2501.00001v1");
    expect(entry.title).toBe("Example Paper");
    expect(entry.summary).toBe("This is the abstract of the paper.");
    expect(entry.authors).toBe("Alice Example, Bob Example");
    expect(entry.published).toBe("2025-01-01T00:00:00Z");
    expect(entry.categories).toBe("cs.AI, cs.CL");
  });

  it("returns no categories when the feed is empty of entries", () => {
    expect(parseArxivFeed("<feed></feed>")).toEqual([]);
  });
});

describe("calculator evaluation", () => {
  it("applies operator precedence and parens", () => {
    expect(evaluate("1 + 2 * 3")).toBe(7);
    expect(evaluate("(1 + 2) * 3")).toBe(9);
  });

  it("handles exponentiation right-associative and tighter than unary minus", () => {
    expect(evaluate("2 ^ 3 ^ 2")).toBe(512);
    expect(evaluate("-2 ^ 2")).toBe(-4);
  });

  it("handles decimals and division", () => {
    expect(evaluate("10 / 4")).toBe(2.5);
    expect(evaluate("0.1 + 0.2")).toBeCloseTo(0.3);
  });

  it("rejects malformed input and division by zero", () => {
    expect(() => evaluate("1 2")).toThrow();
    expect(() => evaluate("1 +")).toThrow();
    expect(() => evaluate("1 / 0")).toThrow();
    expect(() => evaluate("2 @ 3")).toThrow();
  });
});

describe("createStockToolset", () => {
  it("produces matching definitions and implementations for every tool", () => {
    const { definitions, implementations } = createStockToolset({ storage });
    const names = definitions.map((definition) => definition.name);
    expect(names).toEqual([
      "web_fetch",
      "wikipedia_lookup",
      "calculator",
      "weather",
      "package_info",
      "hacker_news_lookup",
      "arxiv_search",
      "web_search",
      "self_reputation",
      "lookup_agent",
      "verify_attestation",
    ]);
    for (const name of names) {
      expect(typeof implementations[name]).toBe("function");
    }
    // the invariant the run loop depends on: no implementation without a
    // definition and no leftover implementation keyed by a missing name.
    expect(Object.keys(implementations).sort()).toEqual([...names].sort());
  });
});