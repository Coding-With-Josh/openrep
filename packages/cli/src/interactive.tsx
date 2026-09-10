// the interactive tui root: the react app that owns the screen state
// machine, the background score poll, and the async actions (create, chat
// turn, revoke, verify). launched from src/index.ts when `openrep` runs
// with no subcommand, on a tty.
//
// state machine (see build-phase 1):
//   splash -> dashboard (any key)              [help overlay ? toggles]
//   dashboard -> chat (enter) / score (s) / create (n) / revoke (r + y)
//   chat -> dashboard (esc)                    [key prompt: saved key -> turn]
//   score -> dashboard (esc) / prev/next agent (up/down)
//   any screen -> exit (ctrl+c, q on dashboard)
//
// chat sub-state: when a turn is sent with no provider key anywhere
// (env -> custody stores), the turn is parked on a masked key prompt. saving
// a key persists it via custody (keychain/encrypted file), then resumes the
// parked turn; esc cancels the prompt and stays on chat.
//
// every action that can prompt for a passphrase (custody resolution) runs
// inside suspendTerminal so the secret never crosses the tui's raw-mode
// stdin. the busy flag gates navigation/actions while an async action is
// in flight, preventing out-of-order state transitions.

import { useEffect, useMemo, useRef, useState } from "react";
import { Box, render, useApp, useInput } from "ink";
import { createProviderClient, createStockToolset, getScore, wrapAgent, MAX_HISTORY_TURNS, type AgentConfig, type AgentRecord, type AgentScore, type ChatHistoryTurn, type StorageAdapter } from "@openrepso/sdk";
import { createHash } from "node:crypto";

import type { CliContext } from "./context.js";
import { isProviderApiKey, newSessionId, type CliEnv, type AgentProviderConfig } from "./config.js";
import { runCreateAgent, runRevokeAgent, runVerifyAgent, type ActionOutcome } from "./commands/actions.js";
import { CustodyError } from "./custody/types.js";
import { Splash } from "./ui/splash.js";
import { Dashboard } from "./ui/dashboard.js";
import { Chat } from "./ui/chat.js";
import { Score } from "./ui/score.js";
import type { Screen, UiAgentRow, UiChatEntry, UiError, UiTurnResult, UiVerifyState } from "./ui/types.js";

// how often the background poll refreshes rows and scores (ms). fast enough
// to feel live, slow enough to not hammer the sqlite file on every keystroke.
const POLL_INTERVAL_MS = 5000;

// polling is skipped on the splash screen entirely; the dashboard and chat
// headers read the same reconciled rows.
const POLL_SKIP_SCREENS = new Set<Screen>(["splash"]);

export interface InteractiveProps {
  ctx: CliContext;
  provider: AgentProviderConfig;
  initialScreen?: Screen; // test seam: pin the splash gate off
}

export function InteractiveApp({ ctx, provider, initialScreen = "splash" }: InteractiveProps) {
  const app = useApp();

  const sessionId = useMemo(() => newSessionId(), []);

  const [screen, setScreen] = useState<Screen>(initialScreen);
  const [rows, setRows] = useState<UiAgentRow[]>([]);
  const [selected, setSelected] = useState(0);
  const [lastScores, setLastScores] = useState<Record<string, number>>({});
  const [helpOpen, setHelpOpen] = useState(false);
  const [error, setError] = useState<UiError | null>(null);

  // per-agent chat history, kept in memory for the session (never persisted:
  // the chat screen is a local exploration surface, source stays "native").
  const [chatByAgent, setChatByAgent] = useState<Record<string, UiChatEntry[]>>({});
  const [liveTools, setLiveTools] = useState<{ tool: string; input: unknown }[]>([]);
  const [chatSending, setChatSending] = useState(false);
  // the agent the chat or score screen is currently open on. the chat and
  // score screens are mutually exclusive with each other and with the
  // dashboard, so one handle serves both.
  const [currentPub, setCurrentPub] = useState<string | null>(null);

  // --- provider api key state ----------------------------------------------
  // apiKeyRef holds the effective key for this session: the env value wins,
  // else a key resolved from the custody stores, else a key the user typed
  // and saved. it lives in a ref (never renders) so the raw secret cannot
  // reach the render tree; only the flags below drive the ui.
  const apiKeyRef = useRef<string | undefined>(undefined);
  // whether a key is known this session without resuming the custody walk.
  const [apiKeyResolved, setApiKeyResolved] = useState(false);
  // a chat turn parked because no key was found: the chat screen renders a
  // masked key prompt instead of the message input until the user cancels
  // or saves a key.
  const [keyPrompt, setKeyPrompt] = useState<{ agent: AgentRecord; text: string } | null>(null);
  const [keySaving, setKeySaving] = useState(false);

  // per-agent verify state (audit buffers are agent scoped, like the ci
  // command is per agent).
  const [verifyByAgent, setVerifyByAgent] = useState<Record<string, UiVerifyState>>({});

  // busy is a ref, not state: it gates async entry points inside event
  // handlers that close over stale renders, and it must be checked without
  // triggering re-renders.
  const busyRef = useRef(false);

  // keep the latest screen value reachable from the interval closure
  // without re-registering the interval on every screen change.
  const screenRef = useRef(screen);
  screenRef.current = screen;

  // --- background poll -----------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      if (busyRef.current) return; // never tear the chat mid-run
      try {
        const next = await reconcileRows(ctx.storage, getScore, ctx.storage.listAllAgents.bind(ctx.storage));
        if (cancelled) return;
        // deltas are relative to the first score observed this session: the
        // first observation fills lastScores without moving the arrow.
        setRows((prev) => {
          setLastScores((last) => {
            const merged = { ...last };
            for (const row of next) {
              if (row.score !== null && last[row.record.publicKey] === undefined) {
                merged[row.record.publicKey] = row.score.composite;
              }
            }
            return merged;
          });
          return next;
        });
      } catch {
        // keep the last good rows. a storage outage should read as
        // "staleness on screen", never as a crash or a swallowed error.
      }
    };

    void refresh();
    const timer = setInterval(() => {
      if (!POLL_SKIP_SCREENS.has(screenRef.current)) void refresh();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [ctx]);

  // ctrl+n anywhere starts the create flow (dashboard shows progress via the
  // busy flag; the splash's own handler ignores ctrl chords, so no conflict).
  useInput((input, key) => {
    if (key.ctrl && (input === "n" || input === "\u000e")) {
      setScreen("dashboard");
      setHelpOpen(false);
      void handleCreate();
    }
  });

  // --- shared action plumbing ---------------------------------------------

  async function runAction(fn: () => Promise<ActionOutcome<unknown>>): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true;
    setError(null);
    try {
      const outcome = await fn();
      if (outcome.kind !== "ok") {
        // the "<CODE>: <message>" contract is the same one the cli prints to
        // stderr; the tui renders it in red instead.
        const error = outcome.kind === "sdk-error"
          ? { code: outcome.error.code, message: outcome.error.message }
          : { code: outcome.code, message: outcome.message };
        setError(error);
        return false;
      }
      return true;
    } catch (err) {
      // custody hard failures (no store accepted the keys) and unexpected
      // throws: render a message, never a stack trace.
      if (err instanceof CustodyError) {
        setError({ code: err.code, message: err.message });
      } else if (err instanceof Error && err.message.length > 0) {
        setError({ code: "INTERNAL", message: err.message });
      } else {
        setError({ code: "INTERNAL", message: "unexpected error" });
      }
      return false;
    } finally {
      busyRef.current = false;
    }
  }

  // custody may prompt for a passphrase on stderr; that readline owner needs
  // the terminal out of ink's raw mode, so key-touching actions run under
  // suspension. suspendTerminal's callback form restores the terminal even
  // when the callback throws.
  async function handleCreate(): Promise<void> {
    let ok = false;
    await app.suspendTerminal(async () => {
      ok = await runAction(() => runCreateAgent(ctx, undefined));
    });
    if (ok) await refreshNow();
  }

  async function handleRevoke(row: UiAgentRow): Promise<void> {
    let ok = false;
    await app.suspendTerminal(async () => {
      ok = await runAction(() => runRevokeAgent(ctx, row.record));
    });
    if (ok) await refreshNow();
  }

  async function handleVerify(row: UiAgentRow): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setVerifyByAgent((prev) => ({
      ...prev,
      [row.record.publicKey]: { running: true, lines: [], failed: false },
    }));
    try {
      const buffer: string[] = [];
      const summary = await runVerifyAgent(row.record, ctx.storage, (line) => buffer.push(line));
      setVerifyByAgent((prev) => ({
        ...prev,
        [row.record.publicKey]: { running: false, lines: buffer, failed: !summary.valid },
      }));
    } catch (err) {
      if (err instanceof CustodyError) {
        setError({ code: err.code, message: err.message });
      } else if (err instanceof Error && err.message.length > 0) {
        setError({ code: "INTERNAL", message: err.message });
      } else {
        setError({ code: "INTERNAL", message: "unexpected error" });
      }
    } finally {
      busyRef.current = false;
    }
  }

  async function refreshNow(): Promise<void> {
    if (busyRef.current) return;
    const next = await reconcileRows(ctx.storage, getScore, ctx.storage.listAllAgents.bind(ctx.storage));
    setRows(next);
  }

  // --- chat turn -----------------------------------------------------------

  function pushUserEntry(agentPub: string, text: string): void {
    setChatByAgent((prev) => ({
      ...prev,
      [agentPub]: [...(prev[agentPub] ?? []), { role: "user", content: text, toolsUsed: [] }],
    }));
  }

  function pushAssistantEntry(agentPub: string, turn: UiTurnResult): void {
    setChatByAgent((prev) => ({
      ...prev,
      [agentPub]: [
        ...(prev[agentPub] ?? []),
        {
          role: "assistant",
          content: turn.content,
          toolsUsed: turn.toolsUsed,
          attestationId: turn.attestation.id,
        },
      ],
    }));
  }

  // deterministic idempotency key for a (agent, message) pair, so ctrl+r
  // retries collapse into one attestation instead of double-signing.
  function idleTurnKey(agentPub: string, text: string): string {
    return createHash("sha256").update(agentPub).update("\u0000").update(text).digest("hex");
  }

  async function runChatTurn(agent: AgentRecord, text: string): Promise<void> {
    if (busyRef.current) return;
    setError(null);

    // resolve the provider key at the point of use, in precedence order:
    // env (OPENREP_AGENT_API_KEY), then whatever this session already holds
    // (custody-resolved or user-saved), then the custody stores. only when
    // every source comes up empty does the turn park on the key prompt. the
    // env value wins over a stored key, mirroring the identity-key walk.
    let key = provider.apiKey !== undefined && provider.apiKey.length > 0 ? provider.apiKey : apiKeyRef.current;
    if (key === undefined) {
      if (provider.apiKey !== undefined && !isProviderApiKey(provider.apiKey)) {
        setError({
          code: "INVALID_INPUT",
          message: "OPENREP_AGENT_API_KEY is not a valid provider api key (non-empty, at most 512 chars)",
        });
        return;
      }
      try {
        // the encrypted-file fallback may prompt for a passphrase first;
        // that prompt owns the terminal, so the lookup runs under suspension.
        const stored = await withSuspended(app.suspendTerminal, () => ctx.custody.resolveApiKey("groq"));
        key = stored?.key;
        if (key !== undefined) {
          apiKeyRef.current = key;
          setApiKeyResolved(true);
        }
      } catch (err) {
        if (err instanceof CustodyError) {
          setError({ code: err.code, message: err.message });
        } else {
          setError({ code: "INTERNAL", message: "unexpected error resolving the provider api key" });
        }
        return;
      }
      if (key === undefined) {
        // no key anywhere: park the turn on the masked key prompt. busy is
        // NOT set here, so the prompt can take input; the turn resumes when
        // the user saves a key or cancels.
        setKeyPrompt({ agent, text });
        return;
      }
    }

    busyRef.current = true;
    setChatSending(true);
    setLiveTools([]);

    try {
      // the identity key may live behind a passphrase prompt (encrypted file
      // store); that prompt owns the terminal, so resolve it under
      // suspension. suspension restores ink's raw mode before the run loop
      // (the loop itself needs no stdin).
      const resolution = await withSuspended(app.suspendTerminal, () =>
        ctx.custody.resolveIdentityKey(agent.publicKey),
      );
      if (resolution === null) {
        setError({
          code: "KEYCHAIN_UNAVAILABLE",
          message: `no identity signing key available for agent ${agent.publicKey}; run "openrep create" for this agent first`,
        });
        return;
      }

      const toolset = createStockToolset({ storage: ctx.storage });
      const config: AgentConfig = {
        provider: "openai-compatible",
        model: provider.model,
        baseUrl: provider.baseUrl,
        tools: toolset.definitions,
        system: "you are an openrep agent. do the task, use tools when useful, and answer concisely.",
      };
      // createProviderClient validates the base url (https/http) before any
      // request; a bad url is a config error, not a runtime provider failure.
      const client = createProviderClient(config, key);

      const result = await wrapAgent({
        agentId: agent.publicKey,
        signingKey: resolution.key,
        apiKey: key,
        config,
        tools: toolset.implementations,
        storage: ctx.storage,
        ...chatTurnParams(chatByAgent[agent.publicKey] ?? [], text),
        options: {
          source: "native",
          idempotencyKey: idleTurnKey(agent.publicKey, text),
          onToolCall: (toolCall) => {
            setLiveTools((prev) => [...prev, { tool: toolCall.tool, input: toolCall.input }]);
          },
        },
      });

      if (!result.ok) {
        setError({ code: result.error.code, message: result.error.message });
        return;
      }

      pushAssistantEntry(agent.publicKey, {
        attestation: result.value.attestation,
        content: result.value.output,
        toolsUsed: result.value.toolsUsed,
      });
      setLiveTools([]);
      await refreshNow();
    } catch (err) {
      if (err instanceof CustodyError) {
        setError({ code: err.code, message: err.message });
      } else if (err instanceof Error && err.message.length > 0) {
        setError({ code: "INTERNAL", message: err.message });
      } else {
        setError({ code: "INTERNAL", message: "unexpected error" });
      }
    } finally {
      busyRef.current = false;
      setChatSending(false);
    }
  }

  // the masked key prompt's submit: validate, persist via custody (which may
  // prompt for a passphrase under suspension), then resume the parked turn.
  // the key only becomes effective after the store accepted it: a failed
  // save is surfaced, never silently used for the turn.
  async function handleKeySubmit(raw: string): Promise<void> {
    if (keySaving) return;
    const key = raw.trim();
    if (!isProviderApiKey(key)) {
      setError({
        code: "INVALID_INPUT",
        message: "provider api key must be non-empty and at most 512 chars",
      });
      return;
    }
    const pending = keyPrompt;
    if (pending === null) return;
    setKeySaving(true);
    setError(null);
    try {
      await withSuspended(app.suspendTerminal, () => ctx.custody.storeApiKey("groq", key));
      apiKeyRef.current = key;
      setApiKeyResolved(true);
      setKeyPrompt(null);
      setKeySaving(false);
      await runChatTurn(pending.agent, pending.text);
    } catch (err) {
      setKeySaving(false);
      if (err instanceof CustodyError) {
        setError({ code: err.code, message: err.message });
      } else {
        setError({ code: "INTERNAL", message: "unexpected error saving the provider api key" });
      }
    }
  }

  function handleKeyCancel(): void {
    if (keySaving) return;
    setKeyPrompt(null);
    setError(null);
  }

  async function handleSend(row: UiAgentRow, text: string): Promise<void> {
    pushUserEntry(row.record.publicKey, text);
    await runChatTurn(row.record, text);
  }

  async function handleRetry(agentPub: string): Promise<void> {
    if (busyRef.current) return;
    const lastUser = [...(chatByAgent[agentPub] ?? [])].reverse().find((e) => e.role === "user");
    if (lastUser === undefined) return;
    const row = rows.find((r) => r.record.publicKey === agentPub);
    if (row === undefined) return;
    await runChatTurn(row.record, lastUser.content);
  }

  // --- render --------------------------------------------------------------

  // the row the chat/score screens currently act on. falls back to a
  // placeholder record when the poll has not loaded it yet (first paint
  // before the initial reconcile completes).
  const activeRow: UiAgentRow | null = currentPub === null ? null : (rows.find((r) => r.record.publicKey === currentPub) ?? null);

  // neighbors for the score screen's up/down navigation: computed from the
  // reconciled row order, clamped at the list ends (no wrap). a placeholder
  // row (not yet in the reconciled list) disables both directions.
  const currentIndex = currentPub === null ? -1 : rows.findIndex((r) => r.record.publicKey === currentPub);
  const scorePrevRow = currentIndex > 0 ? (rows[currentIndex - 1] ?? null) : null;
  const scoreNextRow = currentIndex >= 0 && currentIndex < rows.length - 1 ? (rows[currentIndex + 1] ?? null) : null;

  return (
    <Box flexDirection="column">
      {screen === "splash" ? (
        <Splash
          storageName={storageName(ctx.env)}
          modelLabel={provider.label}
          model={provider.model}
          sessionId={sessionId}
          helpOpen={helpOpen}
          onHelpToggle={() => setHelpOpen((v) => !v)}
          onContinue={() => setScreen("dashboard")}
          error={error}
        />
      ) : null}

      {screen === "dashboard" ? (
        <Dashboard
          sessionId={sessionId}
          rows={rows}
          lastScores={lastScores}
          selected={selected}
          onSelected={setSelected}
          onChat={(row) => {
            setCurrentPub(row.record.publicKey);
            setError(null);
            setScreen("chat");
          }}
          onScore={(row) => {
            // the score screen reuses the same current agent handle.
            setCurrentPub(row.record.publicKey);
            setError(null);
            setScreen("score");
          }}
          onRevoke={(row) => void handleRevoke(row)}
          onNewAgent={() => void handleCreate()}
          onQuit={() => app.exit()}
          busy={busyRef.current}
          error={error}
        />
      ) : null}

      {screen === "chat" && currentPub !== null ? (
        <Chat
          agent={activeRow ?? placeholderRow(currentPub)}
          previousScore={lastScores[currentPub]}
          entries={chatByAgent[currentPub] ?? []}
          liveTools={liveTools}
          sending={chatSending}
          apiKeyMissing={provider.apiKey === undefined || provider.apiKey.length === 0 ? !apiKeyResolved : false}
          keyPromptActive={keyPrompt !== null}
          keySaving={keySaving}
          onKeySubmit={(key) => void handleKeySubmit(key)}
          onKeyCancel={handleKeyCancel}
          onSend={(text) => void handleSend(activeRow ?? placeholderRow(currentPub), text)}
          onBack={() => {
            setScreen("dashboard");
            setError(null);
          }}
          onRetry={() => void handleRetry(currentPub)}
          error={error}
        />
      ) : null}

      {screen === "score" && currentPub !== null ? (
        <Score
          agent={activeRow ?? placeholderRow(currentPub)}
          verify={verifyByAgent[currentPub] ?? { running: false, lines: [], failed: false }}
          hasPrev={scorePrevRow !== null}
          hasNext={scoreNextRow !== null}
          onPrevAgent={() => {
            if (scorePrevRow !== null) {
              setCurrentPub(scorePrevRow.record.publicKey);
              setError(null);
            }
          }}
          onNextAgent={() => {
            if (scoreNextRow !== null) {
              setCurrentPub(scoreNextRow.record.publicKey);
              setError(null);
            }
          }}
          onVerify={() => {
            if (activeRow !== null) void handleVerify(activeRow);
          }}
          onBack={() => {
            setScreen("dashboard");
            setError(null);
          }}
          error={error}
        />
      ) : null}
    </Box>
  );
}

// --- chat history (context for the next turn) ------------------------------

// the history handed to wrapAgent for one chat turn: previous entries as
// { role, content } context, minus the current user message (wrapAgent seeds
// the task itself as the latest user turn, so including it would duplicate
// it). the drop rule is idempotent by design: handleSend pushes the user
// entry BEFORE the turn runs (stale state: the push may not be visible yet)
// while handleRetry runs with the entry already present, so a trailing user
// entry whose content equals the current text is always removed, whether or
// not the state flush already included it.
//
// the friendly cap here (MAX_HISTORY_TURNS, from the sdk) bounds the array
// before it leaves the process; the sdk's normalizeHistory enforces the
// real contract (turn AND character budgets) at its own boundary when the
// run starts, so a too-long history can never inject a malformed turn.
export function historySliceForTurn(entries: UiChatEntry[], text: string): ChatHistoryTurn[] {
  const slice = [...entries];
  const last = slice[slice.length - 1];
  if (last !== undefined && last.role === "user" && last.content === text) {
    slice.pop();
  }
  return slice
    .filter((e): e is UiChatEntry & { role: "user" | "assistant" } => e.role === "user" || e.role === "assistant")
    .map((e) => ({ role: e.role, content: e.content }))
    .slice(-MAX_HISTORY_TURNS);
}

// the wrapAgent input fields for one chat turn: the task plus the history
// slice. kept as one pure function so the idempotency rule above is unit-
// tested exactly as the run path uses it.
export function chatTurnParams(entries: UiChatEntry[], text: string): { task: string; history: ChatHistoryTurn[] } {
  return { task: text, history: historySliceForTurn(entries, text) };
}

// --- helpers ---------------------------------------------------------------

// run an async fn while the terminal is suspended, returning its value.
// suspendTerminal's callback form restores ink's raw mode even when the
// callback throws, and suspendTerminal never propagates the callback's
// value, so the value is returned here instead of captured into a closure
// (a closure-captured variable would defeat typescript's narrowing: ts
// treats it as never reassigned and a later null-check would collapse the
// variable to never).
async function withSuspended<T>(
  suspend: (callback: () => void | Promise<void>) => Promise<void>,
  fn: () => Promise<T>,
): Promise<T> {
  let value!: T;
  await suspend(async () => {
    value = await fn();
  });
  return value;
}

// reconcile the storage's agent list with a fresh score per agent. scoring
// failures (e.g. SCORE_COMPUTATION_LIMIT_EXCEEDED) keep the row visible with
// a null score rather than hiding an agent from the dashboard. listAll is
// passed as a bound function so callers can swap the source in tests.
async function reconcileRows(
  storage: StorageAdapter,
  score: typeof getScore,
  listAll: StorageAdapter["listAllAgents"],
): Promise<UiAgentRow[]> {
  const records = await listAll();
  const rows: UiAgentRow[] = [];
  for (const record of records) {
    let agentScore: AgentScore | null = null;
    try {
      const result = await score(record.publicKey, storage);
      if (result.ok) agentScore = result.value;
    } catch {
      agentScore = null;
    }
    rows.push({ record, score: agentScore });
  }
  return rows;
}

// placeholder row for the split second before the first poll lands; never
// used for writes, only for a stable first paint of the chat header.
function placeholderRow(pub: string): UiAgentRow {
  return {
    record: {
      name: pub,
      publicKey: pub,
      ownerPublicKey: null,
      memoryPointer: null,
      permissions: [],
      createdAt: "",
      manifestVersion: 0,
      signature: "",
      revokedAt: null,
      visibility: "public",
    },
    score: null,
  };
}

// the storage dot is honest: the cli's context always constructs the sqlite
// adapter (see context.ts), so the label says sqlite. turso wiring is an
// sdk/web-layer concern and labeling anything else would be a lie, so the
// dot never claims a backend that buildContext did not actually open.
function storageName(env: CliEnv): string {
  void env;
  return "sqlite";
}

// --- launcher --------------------------------------------------------------

export interface LaunchInteractiveResult {
  exitCode: number;
}

// entry point called by src/index.ts only when argv has no subcommand. the
// caller already gated on process.stdout.isTTY, so this function may assume
// a real terminal.
export async function launchInteractive(
  ctx: CliContext,
  provider: AgentProviderConfig,
): Promise<LaunchInteractiveResult> {
  const instance = render(<InteractiveApp ctx={ctx} provider={provider} />, {
    exitOnCtrlC: true,
    // the alternate screen keeps the tui from polluting the user's
    // scrollback; on exit ink restores the previous screen contents.
    patchConsole: false,
  });
  await instance.waitUntilExit();
  return { exitCode: 0 };
}