// pure formatting helpers for the tui. these are the deterministic pieces
// every screen renders from, so they get the full unit-test pass: layout
// regressions are caught here, not in a flaky terminal harness.

import { describe, expect, it } from "vitest";

import {
  agentHeaderName,
  agentSecondaryLine,
  barCells,
  deltaArrow,
  formatScore,
  scoreDeltaString,
  shortPubKey,
  sourceCountLine,
  statusIcon,
  splashModelLine,
  storageDotLine,
  tailLines,
  toolCallSummary,
  verifyBadge,
  visibilityBadge,
} from "../src/ui/format.js";

describe("shortPubKey", () => {
  it("abbreviates long public keys to 4...4 form", () => {
    expect(shortPubKey("7f3a0123456789abcdef4b1d")).toBe("7f3a...4b1d");
  });
  it("leaves already-short strings untouched", () => {
    expect(shortPubKey("abc")).toBe("abc");
  });
  it("handles attestation-style ids", () => {
    expect(shortPubKey("0x4b1d8f2e")).toBe("0x4b...8f2e");
  });
});

describe("statusIcon", () => {
  const base = {
    name: "x",
    publicKey: "a".repeat(64),
    ownerPublicKey: null,
    memoryPointer: null,
    permissions: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    manifestVersion: 1,
    signature: "s",
    revokedAt: null,
    visibility: "public" as const,
  };
  it("marks active agents with a filled dot", () => {
    expect(statusIcon(base)).toBe("●");
  });
  it("marks revoked agents with an empty dot", () => {
    expect(statusIcon({ ...base, revokedAt: "2026-02-01T00:00:00.000Z" })).toBe("○");
  });
});

describe("visibilityBadge", () => {
  const base = {
    name: "x",
    publicKey: "a".repeat(64),
    ownerPublicKey: null,
    memoryPointer: null,
    permissions: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    manifestVersion: 1,
    signature: "s",
    revokedAt: null,
    visibility: "public" as const,
  };
  it("shows [pub] for a public agent", () => {
    expect(visibilityBadge(base)).toBe("[pub]");
  });
  it("shows [priv] for a private agent", () => {
    expect(visibilityBadge({ ...base, visibility: "private" })).toBe("[priv]");
  });
});

describe("formatScore", () => {
  it("renders fixed two decimals", () => {
    expect(formatScore(1.4)).toBe("1.40");
    expect(formatScore(0)).toBe("0.00");
    expect(formatScore(2.006)).toBe("2.01");
  });
});

describe("deltaArrow / scoreDeltaString", () => {
  it("shows an up arrow above the threshold", () => {
    expect(deltaArrow(1.5, 1.4)).toBe("↑");
  });
  it("shows a down arrow below the threshold", () => {
    expect(deltaArrow(1.3, 1.4)).toBe("↓");
  });
  it("stays flat inside the threshold", () => {
    expect(deltaArrow(1.4001, 1.4)).toBe(" ");
  });
  it("renders no arrow when there is no previous value", () => {
    expect(deltaArrow(1.5, undefined)).toBe(" ");
  });
  it("formats signed deltas for the chat header", () => {
    expect(scoreDeltaString(1.5, 1.4)).toBe("+0.10");
    expect(scoreDeltaString(1.3, 1.4)).toBe("-0.10");
    expect(scoreDeltaString(1.4, 1.4)).toBeNull();
    expect(scoreDeltaString(1.5, undefined)).toBeNull();
  });
});

describe("barCells", () => {
  it("renders the documented 0.80 example as 8 of 16 cells", () => {
    expect(barCells(0.8)).toBe("████████░░░░░░░░");
  });
  it("renders zero and full scale", () => {
    expect(barCells(0)).toBe("░".repeat(16));
    expect(barCells(2)).toBe("█".repeat(16));
  });
  it("clamps negative input", () => {
    expect(barCells(-1)).toBe("░".repeat(16));
  });
  it("supports custom widths for layout control", () => {
    expect(barCells(0.5, 10)).toBe("█████░░░░░");
  });
});

describe("sourceCountLine", () => {
  it("joins source names with counts in order", () => {
    expect(sourceCountLine([{ source: "native", value: 1, count: 2, lastUpdated: "" }, { source: "chat", value: 0, count: 3, lastUpdated: "" }])).toBe("native 2 · chat 3");
  });
  it("handles an empty breakdown", () => {
    expect(sourceCountLine(undefined)).toBe("no attestations yet");
    expect(sourceCountLine([])).toBe("no attestations yet");
  });
});

describe("agentSecondaryLine", () => {
  it("renders pubkey plus source counts", () => {
    const row = {
      record: {
        name: "x",
        publicKey: "7f3a0123456789abcdef4b1d",
        ownerPublicKey: null,
        memoryPointer: null,
        permissions: [],
        createdAt: "",
        manifestVersion: 1,
        signature: "",
        revokedAt: null,
      },
      score: {
        agentId: "7f3a0123456789abcdef4b1d",
        composite: 1.4,
        computedAt: "",
        breakdown: [{ source: "native", value: 0.8, count: 4, lastUpdated: "" }],
      },
    };
    expect(agentSecondaryLine(row)).toBe("7f3a...4b1d · native 4");
  });
  it("shows only the pubkey when there are no attestations", () => {
    const row = {
      record: {
        name: "x",
        publicKey: "7f3a0123456789abcdef4b1d",
        ownerPublicKey: null,
        memoryPointer: null,
        permissions: [],
        createdAt: "",
        manifestVersion: 1,
        signature: "",
        revokedAt: null,
      },
      score: {
        agentId: "7f3a0123456789abcdef4b1d",
        composite: 0,
        computedAt: "",
        breakdown: [],
      },
    };
    expect(agentSecondaryLine(row)).toBe("7f3a...4b1d");
  });
});

describe("toolCallSummary", () => {
  it("summarizes web_fetch by url", () => {
    expect(toolCallSummary({ tool: "web_fetch", input: { url: "https://example.com/releases" } })).toBe("reading https://example.com/releases");
  });
  it("summarizes web_search by query", () => {
    expect(toolCallSummary({ tool: "web_search", input: { query: "openrep" } })).toBe("searching openrep");
  });
  it("falls back to the generic form for unknown tools", () => {
    expect(toolCallSummary({ tool: "calculator", input: { expression: "1+1" } })).toBe("running calculator");
  });
  it("is defensive against malformed input", () => {
    expect(toolCallSummary({ tool: "web_fetch", input: null })).toBe("running web_fetch");
    expect(toolCallSummary({ tool: "web_fetch", input: { url: 42 } })).toBe("running web_fetch");
  });
});

describe("verifyBadge", () => {
  it("renders the passed badge for a clean audit", () => {
    expect(verifyBadge(true, 4)).toBe("verify passed 4/4");
  });
  it("renders the failed badge for an unclean audit", () => {
    expect(verifyBadge(false, 4)).toBe("verify failed 4/4");
  });
  it("renders the not-run state", () => {
    expect(verifyBadge(undefined, undefined)).toBe("verify not run yet");
  });
});

describe("tailLines", () => {
  it("returns the last max lines oldest-first", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    expect(tailLines(lines, 4)).toEqual(["line 16", "line 17", "line 18", "line 19"]);
  });
});

describe("splash line helpers", () => {
  it("renders the model line as label: model", () => {
    expect(splashModelLine("groq", "openai/gpt-oss-20b")).toBe("groq: openai/gpt-oss-20b");
  });
  it("renders the storage dot line verbatim", () => {
    expect(storageDotLine("sqlite")).toBe("connected to sqlite");
  });
});

describe("agentHeaderName", () => {
  it("combines name and short pubkey", () => {
    expect(agentHeaderName({
      name: "loud-fox-7.agent",
      publicKey: "7f3a0123456789abcdef4b1d",
      ownerPublicKey: null,
      memoryPointer: null,
      permissions: [],
      createdAt: "",
      manifestVersion: 1,
      signature: "",
      revokedAt: null,
    })).toBe("loud-fox-7.agent 7f3a...4b1d");
  });
});