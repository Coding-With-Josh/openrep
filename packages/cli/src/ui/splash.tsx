// screen 0: the launch splash. the wordmark, the tagline, three honest
// status dots, and a prompt line. any key except the specials moves on to
// the dashboard; "?" opens the help overlay. nothing on this screen touches
// storage or keys; it renders from the resolved config only and stays
// responsive even while the background poll runs.

import { Box, Text, useInput } from "ink";

import { splashModelLine, storageDotLine } from "./format.js";
import type { UiError } from "./types.js";

// block-letter wordmark: each glyph is 5 rows of block characters, built
// from five 5x8 letters (o, n, and the others) so the whole line spells
// the project name. rows stay inside a normal terminal width (68 chars).
const LOGO = [
  " ██████   ██████    ███████   ██    ██   ██████   ███████   ██████  ",
  "██    ██  ██    ██  ██        ███   ██  ██    ██  ██        ██    ██  ",
  "██    ██  ██    ██  █████     ████  ██  ██    ██  █████     ██    ██  ",
  "██    ██  ██████    ██        ██ ██ ██  ██████    ██        ██████    ",
  " ██████   ██        ███████   ██    ██  ██  ██    ███████   ██        ",
];

export interface SplashProps {
  storageName: string;
  modelLabel: string;
  model: string;
  sessionId: string;
  helpOpen: boolean;
  onHelpToggle: () => void;
  onContinue: () => void;
  error: UiError | null;
}

export function Splash({ storageName, modelLabel, model, sessionId, helpOpen, onHelpToggle, onContinue, error }: SplashProps) {
  useInput((input, key) => {
    if (key.ctrl) return; // ctrl+c is exitOnCtrlC, ctrl+n routes at the app level

    if (input === "?" || input === "h") {
      onHelpToggle();
      return;
    }

    // any other key (including esc and enter) moves on. the splash is a
    // "press any key" gate, not a menu.
    onContinue();
  });

  if (helpOpen) {
    return (
      <Box flexDirection="column" padding={1}>
        <Box borderStyle="round" flexDirection="column" padding={1} marginBottom={1}>
          <Text bold>help</Text>
          <Box flexDirection="column" marginTop={1}>
            <Text>any key    open your agents</Text>
            <Text>ctrl+n     new agent (create flow)</Text>
            <Text>?          toggle this help</Text>
            <Text>ctrl+c     exit</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>press any key to continue</Text>
          </Box>
        </Box>
        {error !== null ? <ErrorLine error={error} /> : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box borderStyle="round" flexDirection="column" padding={1}>
        <Box flexDirection="column">
          {LOGO.map((line) => (
            <Text key={line} color="cyan">
              {line}
            </Text>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>platform-agnostic reputation layer for ai agents</Text>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color="green">● </Text>
            <Text>{storageDotLine(storageName)}</Text>
          </Text>
          <Text>
            <Text color="cyan">● </Text>
            <Text>{splashModelLine(modelLabel, model)}</Text>
          </Text>
          <Text>
            <Text color="yellow">● </Text>
            <Text>session {sessionId} (guest)</Text>
          </Text>
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text color="green">&gt; </Text>
        <Text dimColor>press any key to continue</Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>ctrl+c exit · ctrl+n new agent · ? help</Text>
      </Box>

      {error !== null ? <ErrorLine error={error} /> : null}
    </Box>
  );
}

// shared red error line, used by every screen. the message already comes
// from the standardized "<CODE>: <message>" contract; it never includes
// stack traces or key material.
export function ErrorLine({ error }: { error: UiError }) {
  return (
    <Box marginTop={1}>
      <Text color="red">
        {error.code}: {error.message}
      </Text>
    </Box>
  );
}