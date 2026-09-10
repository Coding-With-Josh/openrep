// screen 2: the agent chat. one user message per turn; each turn runs
// wrapAgent against the configured provider and, on convergence, signs and
// persists a native attestation (the same sdk path `openrep attest` uses,
// source closed to "native").
//
// the input prompt is a controlled PromptInput; esc and ctrl+r stay live
// even while the prompt is focused, so "esc back" and "ctrl+r retry" are
// always reachable. a running turn paints tool calls live via the sdk's
// onToolCall hook; nothing here ever renders a private key.

import { useState } from "react";
import { Box, Text, useInput } from "ink";

import { formatScore, scoreDeltaString, shortPubKey, toolCallSummary } from "./format.js";
import { PromptInput } from "./prompt.js";
import type { UiChatEntry, UiError, UiAgentRow } from "./types.js";
import { ErrorLine } from "./splash.js";

export interface ChatProps {
  agent: UiAgentRow;
  previousScore: number | undefined;
  entries: UiChatEntry[];
  liveTools: { tool: string; input: unknown }[];
  sending: boolean;
  apiKeyMissing: boolean;
  keyPromptActive: boolean;
  keySaving: boolean;
  onKeySubmit: (key: string) => void;
  onKeyCancel: () => void;
  onSend: (text: string) => void;
  onBack: () => void;
  onRetry: () => void;
  error: UiError | null;
}

export function Chat({ agent, previousScore, entries, liveTools, sending, apiKeyMissing, keyPromptActive, keySaving, onKeySubmit, onKeyCancel, onSend, onBack, onRetry, error }: ChatProps) {
  const [draft, setDraft] = useState("");
  const [keyDraft, setKeyDraft] = useState("");

  useInput((_input, key) => {
    // esc always leaves the chat screen, even mid-turn: a running turn is
    // anchored to this agent's state and completing it is safe (attest
    // dedupes via idempotency key), so navigation is permitted. while the
    // api-key prompt is open, esc cancels the prompt instead of leaving,
    // so a half-typed key cannot be dropped by accident.
    if (key.escape) {
      if (keyPromptActive) {
        onKeyCancel();
      } else {
        onBack();
      }
      return;
    }
    // ctrl+r retries the last user message. meaningful only when there is a
    // user turn and nothing is already running.
    if (key.ctrl && key.return === false && key.escape === false && !keyPromptActive && !sending) {
      onRetry();
      return;
    }
  });

  const composite = agent.score?.composite;
  const delta = composite !== undefined ? scoreDeltaString(composite, previousScore) : null;

  return (
    <Box flexDirection="column" padding={1}>
      <Box>
        <Text bold>{agent.record.name}</Text>
        {composite !== undefined ? (
          <Text>
            {" "}
            <Text dimColor>score </Text>
            {formatScore(composite)}
            {delta !== null ? <Text color="green"> ({delta})</Text> : null}
          </Text>
        ) : (
          <Text dimColor> score unavailable</Text>
        )}
      </Box>

      {apiKeyMissing && !keyPromptActive ? (
        <Box marginTop={1}>
          <Text color="yellow">no provider api key; chat will ask for one when you send a message</Text>
        </Box>
      ) : null}

      <Box flexDirection="column" marginTop={1}>
        {entries.length === 0 ? (
          <Text dimColor>no messages yet. ask the agent something.</Text>
        ) : (
          entries.map((entry, index) => <MessageEntry key={index} entry={entry} />)
        )}

        {sending ? <RunningPanel tools={liveTools} /> : null}
      </Box>

      {keyPromptActive ? (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color="yellow">no provider api key on file. paste one to save and send:</Text>
          </Box>
          <Box marginTop={1}>
            <PromptInput
              value={keyDraft}
              onChange={setKeyDraft}
              onSubmit={(key) => {
                setKeyDraft("");
                onKeySubmit(key);
              }}
              placeholder="groq api key (gsk_...)"
              focused={!keySaving}
              secret
            />
          </Box>
          <Box marginTop={1}>
            <Text dimColor>esc cancel · key is saved to keychain/encrypted store</Text>
          </Box>
        </Box>
      ) : (
        <Box marginTop={1}>
          <PromptInput
            value={draft}
            onChange={setDraft}
            onSubmit={(text) => {
              setDraft("");
              onSend(text);
            }}
            placeholder="ask the agent to research, fetch, or summarize"
            focused={!sending}
          />
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>esc back · ctrl+r retry · ctrl+c quit</Text>
      </Box>

      {error !== null ? <ErrorLine error={error} /> : null}
    </Box>
  );
}

function MessageEntry({ entry }: { entry: UiChatEntry }) {
  if (entry.role === "user") {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="green" dimColor>
            you
          </Text>
          <Text> {entry.content}</Text>
        </Box>
        {entry.toolsUsed.length > 0 ? (
          <Box paddingLeft={5} flexDirection="column">
            {entry.toolsUsed.map((tool, i) => (
              <Text key={i} dimColor>
                ▸ {toolCallSummary(tool)}
              </Text>
            ))}
          </Box>
        ) : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>{entry.content}</Text>
      {entry.toolsUsed.length > 0 ? (
        <Box paddingLeft={2} flexDirection="column">
          {entry.toolsUsed.map((tool, i) => (
            <Text key={i} dimColor>
              ▸ {toolCallSummary(tool)}
            </Text>
          ))}
        </Box>
      ) : null}
      {entry.attestationId ? (
        <Box paddingLeft={2}>
          <Text color="green" dimColor>
            attestation {shortPubKey(entry.attestationId)}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

// the live "◐ running" block during a wrapped turn: every tool call the
// model made this far, painted as it happens via onToolCall.
function RunningPanel({ tools }: { tools: { tool: string; input: unknown }[] }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color="magenta">◐ running</Text>
      </Box>
      {tools.map((tool, i) => (
        <Box key={i} paddingLeft={2}>
          <Text dimColor>▸ {toolCallSummary(tool)}</Text>
        </Box>
      ))}
    </Box>
  );
}