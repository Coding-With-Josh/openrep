// screen 1: the agent dashboard. a numbered list of every stored agent with
// live score deltas, and the navigation surface for chat/score/revoke.
//
// navigation is number keys + single letters (no arrow keys), per the spec.
// "r" never revokes immediately: it arms a y/n confirmation rendered inline,
// so the irreversible action always requires an explicit second keystroke.

import { useState } from "react";
import { Box, Text, useInput } from "ink";

import { agentSecondaryLine, deltaArrow, formatScore, statusIcon } from "./format.js";
import type { UiAgentRow, UiError } from "./types.js";
import { ErrorLine } from "./splash.js";

export interface DashboardProps {
  sessionId: string;
  rows: UiAgentRow[];
  lastScores: Record<string, number>;
  selected: number;
  onSelected: (index: number) => void;
  onChat: (row: UiAgentRow) => void;
  onScore: (row: UiAgentRow) => void;
  onRevoke: (row: UiAgentRow) => void;
  onNewAgent: () => void;
  onQuit: () => void;
  busy: boolean;
  error: UiError | null;
}

export function Dashboard(props: DashboardProps) {
  // local confirm state: r arms it, y fires the actual revoke action, n or
  // any other key disarms it. deliberately local so the app-level state
  // machine never observes a half-confirmed revoke.
  const [confirmIndex, setConfirmIndex] = useState<number | null>(null);

  const { rows, selected, busy } = props;
  const { error } = props;

  useInput((input, key) => {
    // the app is currently running an async action (chat turn, verify,
    // create, revoke); keystrokes are ignored so a half-rendered screen
    // can not be navigated out from under the worker.
    if (busy) return;

    // while a revoke is armed, only y/n/esc mean anything.
    if (confirmIndex !== null) {
      if (input === "y" || input === "Y") {
        const row = rows[confirmIndex];
        if (row !== undefined) {
          setConfirmIndex(null);
          props.onRevoke(row);
        }
      } else {
        setConfirmIndex(null);
      }
      return;
    }

    if (key.ctrl) return; // ctrl+c is exitOnCtrlC, ctrl+n routes at the app level

    if (input === "q" || input === "Q") {
      props.onQuit();
      return;
    }

    if (input === "n" || input === "N") {
      props.onNewAgent();
      return;
    }

    if (input === "s" || input === "S") {
      const row = rows[selected];
      if (row !== undefined) props.onScore(row);
      return;
    }

    if (input === "r" || input === "R") {
      if (rows[selected] !== undefined) setConfirmIndex(selected);
      return;
    }

    if (key.return) {
      const row = rows[selected];
      if (row !== undefined) props.onChat(row);
      return;
    }

    // number keys 1..9 select the row at that position.
    const digit = parseInt(input, 10);
    if (!Number.isNaN(digit) && digit >= 1 && digit <= 9) {
      const index = digit - 1;
      if (index < rows.length) props.onSelected(index);
      return;
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Box>
        <Text bold>your agents</Text>
        <Text dimColor> · session {props.sessionId}</Text>
      </Box>

      {rows.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>no agents yet. press n to create one.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {rows.map((row, index) => {
            const isSelected = index === selected;
            const previous = props.lastScores[row.record.publicKey];
            const composite = row.score?.composite;
            return (
              <Box key={row.record.publicKey} flexDirection="column">
                <Box>
                  <Text color={isSelected ? "green" : undefined}>
                    {isSelected ? "» " : "  "}
                    {index + 1} {statusIcon(row.record)} {row.record.name}
                  </Text>
                  {composite !== undefined ? (
                    <Text dimColor>
                      {" "}
                      {deltaArrow(composite, previous)} {formatScore(composite)}
                    </Text>
                  ) : null}
                  {row.record.revokedAt !== null ? <Text color="yellow"> revoked</Text> : null}
                </Box>
                <Box paddingLeft={4}>
                  <Text dimColor>{agentSecondaryLine(row)}</Text>
                </Box>
              </Box>
            );
          })}
        </Box>
      )}

      {confirmIndex !== null ? (
        <Box marginTop={1}>
          <Text color="yellow">revoke {rows[confirmIndex]?.record.name}? [y]es [n]o</Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text dimColor>[n] new agent   [enter] chat   [s] score   [r] revoke   [q] quit</Text>
        </Box>
      )}

      {error !== null ? <ErrorLine error={error} /> : null}
    </Box>
  );
}