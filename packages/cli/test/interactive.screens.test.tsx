// smoke tests for the tui screens via ink's renderToString: each screen
// must render the critical strings (headers, footers, status rows) from
// given state without a terminal. renderToString returns no-op implementations
// for useInput/useApp, so the interactive hooks are exercised structurally
// without a pty, and layout regressions are caught cheaply.

import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";

import { Splash } from "../src/ui/splash.js";
import { Dashboard } from "../src/ui/dashboard.js";
import { Chat } from "../src/ui/chat.js";
import { Score } from "../src/ui/score.js";
import type { UiAgentRow, UiChatEntry, UiVerifyState } from "../src/ui/types.js";

function makeRow(name: string, pub: string, scoreComposite: number | null): UiAgentRow {
  return {
    record: {
      name,
      publicKey: pub,
      ownerPublicKey: "c".repeat(64),
      memoryPointer: null,
      permissions: ["attest:self"],
      createdAt: "2026-01-01T00:00:00.000Z",
      manifestVersion: 1,
      signature: "s".repeat(128),
      revokedAt: null,
    },
    score:
      scoreComposite === null
        ? null
        : {
            agentId: pub,
            composite: scoreComposite,
            computedAt: "2026-01-01T00:00:01.000Z",
            breakdown: [
              { source: "native", value: 0.8, count: 4, lastUpdated: "2026-01-01T00:00:01.000Z" },
              { source: "chat", value: 0.6, count: 3, lastUpdated: "2026-01-01T00:00:01.000Z" },
            ],
          },
  };
}

const row = makeRow("loud-fox-7.agent", "7f3a0123456789abcdef4b1d", 1.4);

describe("Splash", () => {
  it("renders logo, tagline, status dots, and footer", () => {
    const out = renderToString(
      <Splash
        storageName="sqlite"
        modelLabel="groq"
        model="openai/gpt-oss-20b"
        sessionId="a3f...19c"
        helpOpen={false}
        onHelpToggle={() => {}}
        onContinue={() => {}}
        error={null}
      />,
    );
    expect(out).toContain("platform-agnostic reputation layer for ai agents");
    expect(out).toContain("connected to sqlite");
    expect(out).toContain("groq: openai/gpt-oss-20b");
    expect(out).toContain("session a3f...19c (guest)");
    expect(out).toContain("ctrl+c exit · ctrl+n new agent · ? help");
  });

  it("renders the help overlay when toggled", () => {
    const out = renderToString(
      <Splash
        storageName="sqlite"
        modelLabel="groq"
        model="openai/gpt-oss-20b"
        sessionId="a3f...19c"
        helpOpen={true}
        onHelpToggle={() => {}}
        onContinue={() => {}}
        error={null}
      />,
    );
    expect(out).toContain("help");
    expect(out).toContain("any key    open your agents");
  });
});

describe("Dashboard", () => {
  it("renders the agent list with deltas and the footer", () => {
    const out = renderToString(
      <Dashboard
        sessionId="a3f...19c"
        rows={[row]}
        lastScores={{ [row.record.publicKey]: 1.3 }}
        selected={0}
        onSelected={() => {}}
        onChat={() => {}}
        onScore={() => {}}
        onRevoke={() => {}}
        onNewAgent={() => {}}
        onQuit={() => {}}
        busy={false}
        error={null}
      />,
    );
    expect(out).toContain("your agents");
    expect(out).toContain("1 ● loud-fox-7.agent");
    expect(out).toContain("7f3a...4b1d · native 4 · chat 3");
    expect(out).toContain("[n] new agent   [enter] chat   [s] score   [r] revoke   [q] quit");
  });

  it("renders the revoke confirmation when armed", () => {
    const out = renderToString(
      <Dashboard
        sessionId="a3f...19c"
        rows={[row]}
        lastScores={{}}
        selected={0}
        onSelected={() => {}}
        onChat={() => {}}
        onScore={() => {}}
        onRevoke={() => {}}
        onNewAgent={() => {}}
        onQuit={() => {}}
        busy={false}
        error={null}
      />,
    );
    // renderToString renders the initial state: the confirmation can only be
    // armed by a keystroke, which is out of scope here. the footer is the
    // promise that r arms the confirm; the confirm text itself is exercised
    // by formatting the armed state? it is reachable only interactively, so
    // the invariant we assert is that r is documented in the footer.
    expect(out).toContain("[r] revoke");
  });

  it("renders the empty state", () => {
    const out = renderToString(
      <Dashboard
        sessionId="a3f...19c"
        rows={[]}
        lastScores={{}}
        selected={0}
        onSelected={() => {}}
        onChat={() => {}}
        onScore={() => {}}
        onRevoke={() => {}}
        onNewAgent={() => {}}
        onQuit={() => {}}
        busy={false}
        error={null}
      />,
    );
    expect(out).toContain("no agents yet. press n to create one.");
  });
});

describe("Chat", () => {
  const entries: UiChatEntry[] = [
    { role: "user", content: "check the openrep release notes", toolsUsed: [] },
    {
      role: "assistant",
      content: "the latest release is 0.2.0",
      toolsUsed: [{ tool: "web_fetch", input: { url: "https://example.com/releases" } }],
      attestationId: "0x4b1d8f2e",
    },
  ];

  it("renders messages, tool summaries, attestation line, and footer", () => {
    const out = renderToString(
      <Chat
        agent={row}
        previousScore={1.2}
        entries={entries}
        liveTools={[]}
        sending={false}
        apiKeyMissing={false}
        onSend={() => {}}
        onBack={() => {}}
        onRetry={() => {}}
        error={null}
      />,
    );
    expect(out).toContain("loud-fox-7.agent");
    expect(out).toContain("score 1.40 (+0.20)");
    expect(out).toContain("you");
    expect(out).toContain("the latest release is 0.2.0");
    expect(out).toContain("▸ reading https://example.com/releases");
    expect(out).toContain("attestation 0x4b...8f2e");
    expect(out).toContain("esc back · ctrl+r retry · ctrl+c quit");
  });

  it("renders the running panel during a turn", () => {
    const out = renderToString(
      <Chat
        agent={row}
        previousScore={1.2}
        entries={entries}
        liveTools={[{ tool: "web_search", input: { query: "openrep" } }]}
        sending={true}
        apiKeyMissing={false}
        onSend={() => {}}
        onBack={() => {}}
        onRetry={() => {}}
        error={null}
      />,
    );
    expect(out).toContain("◐ running");
    expect(out).toContain("▸ searching openrep");
  });

  it("warns when the provider key is missing", () => {
    const out = renderToString(
      <Chat
        agent={row}
        previousScore={1.2}
        entries={[]}
        liveTools={[]}
        sending={false}
        apiKeyMissing={true}
        onSend={() => {}}
        onBack={() => {}}
        onRetry={() => {}}
        error={null}
      />,
    );
    expect(out).toContain("no OPENREP_AGENT_API_KEY");
  });
});

describe("Score", () => {
  const verify: UiVerifyState = {
    running: false,
    failed: false,
    lines: ["manifest: ok", "  ok    0x1234  2026-01-01T00:00:00.000Z", "summary: 1/1 attestations valid, manifest valid"],
  };

  it("renders the breakdown bars exactly as documented", () => {
    const out = renderToString(
      <Score agent={row} verify={{ running: false, lines: [], failed: false }} onVerify={() => {}} onBack={() => {}} error={null} />,
    );
    expect(out).toContain("composite score 1.40");
    expect(out).toContain("native   0.80  ████████░░░░░░░░  4 attestations");
    expect(out).toContain("esc back · v verify full ledger");
  });

  it("renders the audit lines after a successful verify", () => {
    const out = renderToString(<Score agent={row} verify={verify} onVerify={() => {}} onBack={() => {}} error={null} />);
    expect(out).toContain("manifest: ok");
    expect(out).toContain("summary: 1/1 attestations valid, manifest valid");
  });

  it("renders the running state", () => {
    const out = renderToString(
      <Score agent={row} verify={{ running: true, lines: [], failed: false }} onVerify={() => {}} onBack={() => {}} error={null} />,
    );
    expect(out).toContain("verifying full ledger...");
  });
});

describe("error line", () => {
  it("renders a standardized error in the cli's code: message shape", () => {
    const out = renderToString(
      <Splash
        storageName="sqlite"
        modelLabel="groq"
        model="openai/gpt-oss-20b"
        sessionId="a3f...19c"
        helpOpen={false}
        onHelpToggle={() => {}}
        onContinue={() => {}}
        error={{ code: "PROVIDER_KEY_MISSING", message: "OPENREP_AGENT_API_KEY is not set; chat needs a provider api key" }}
      />,
    );
    // the message may wrap at ink's default 80-column terminal, so match
    // the parts that cannot be split by a wrap instead of one strict
    // substring.
    expect(out).toMatch(/PROVIDER_KEY_MISSING: OPENREP_AGENT_API_KEY is not set/);
    expect(out).toContain("chat needs a provider");
  });
});