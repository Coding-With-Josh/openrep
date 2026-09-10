// screen 3: the score breakdown. the composite score with a verify badge,
// a per-source bar chart, and an in-app "v" action that runs the ci verify
// audit (the exact same paginated runVerifyAgent the `openrep verify`
// command uses) rendered into a bounded buffer. this screen never touches
// process.exitCode: verify here is informational, though the badge and the
// summary line say failed loudly when the audit fails.

import { Box, Text, useInput } from "ink";

import { barCells, formatScore, shortPubKey, tailLines, verifyBadge } from "./format.js";
import type { UiAgentRow, UiError, UiVerifyState } from "./types.js";
import { ErrorLine } from "./splash.js";

export interface ScoreProps {
  agent: UiAgentRow;
  verify: UiVerifyState;
  hasPrev: boolean;
  hasNext: boolean;
  onPrevAgent: () => void;
  onNextAgent: () => void;
  onVerify: () => void;
  onBack: () => void;
  error: UiError | null;
}

export function Score({ agent, verify, hasPrev, hasNext, onPrevAgent, onNextAgent, onVerify, onBack, error }: ScoreProps) {
  useInput((input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    // up/down jump to the previous/next stored agent on the same screen; the
    // app-level handler supplies hasPrev/hasNext so the list bounds are
    // clamped, never wrapped.
    if (key.upArrow && hasPrev) {
      onPrevAgent();
      return;
    }
    if (key.downArrow && hasNext) {
      onNextAgent();
      return;
    }
    if (input === "v" || input === "V") {
      onVerify();
      return;
    }
  });

  const score = agent.score;
  const lines = tailLines(verify.lines);

  return (
    <Box flexDirection="column" padding={1}>
      <Box>
        <Text bold>{agent.record.name}</Text>
        <Text dimColor> {shortPubKey(agent.record.publicKey)}</Text>
      </Box>

      {score === null ? (
        <Box borderStyle="round" marginTop={1} padding={1}>
          <Text dimColor>score unavailable. run verify for a full audit.</Text>
        </Box>
      ) : (
        <Box borderStyle="round" flexDirection="column" marginTop={1} padding={1}>
          <Box>
            <Text bold>composite score </Text>
            <Text bold color="cyan">
              {formatScore(score.composite)}
            </Text>
            <Text> </Text>
            <Text color={verify.failed ? "red" : "green"}>{verifyBadge(verify.failed ? false : undefined, undefined)}</Text>
          </Box>
          <Box flexDirection="column" marginTop={1}>
            {score.breakdown.length === 0 ? (
              <Text dimColor>no attestations yet</Text>
            ) : (
              score.breakdown.map((b) => (
                // one text line per source: padded source name keeps the
                // bars aligned without ink layout quirks on mixed content.
                <Text key={b.source}>
                  {b.source.padEnd(8)} {formatScore(b.value)}  {barCells(b.value)}  {b.count} attestation{b.count === 1 ? "" : "s"}
                </Text>
              ))
            )}
          </Box>
        </Box>
      )}

      <Box borderStyle="round" flexDirection="column" marginTop={1} padding={1}>
        {verify.running ? (
          <Text color="magenta">verifying full ledger...</Text>
        ) : lines.length > 0 ? (
          lines.map((line, i) => (
            <Text key={i} color={verify.failed ? "red" : undefined} dimColor={!verify.failed}>
              {line}
            </Text>
          ))
        ) : (
          <Text dimColor>press v to verify the full attestation ledger.</Text>
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>esc back · v verify full ledger · ↑/↓ agent</Text>
      </Box>

      {error !== null ? <ErrorLine error={error} /> : null}
    </Box>
  );
}