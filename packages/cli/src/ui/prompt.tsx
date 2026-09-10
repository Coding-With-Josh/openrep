// the single-line text input shared by the chat and (indirectly) any prompt
// surface. ink v7 has no built-in TextInput, so this is ours: a controlled
// input box rendered as "> " + value + a block cursor, driven by useInput.
//
// key handling is deliberately narrow. special keys (esc, ctrl+r, arrows,
// ctrl sequences) are NOT consumed here: their owners are the parent
// screens, which receive every keystroke independently of this component.
// this component only appends printable input, backspaces, and submits on
// enter, so a focused prompt never swallows a screen-level shortcut.

import { useState } from "react";
import { Box, Text, useInput } from "ink";

export interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  focused: boolean;
}

export function PromptInput({ value, onChange, onSubmit, placeholder, focused }: PromptInputProps) {
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);

  useInput((input, key) => {
    if (!focused) return;

    // enter submits the current draft. empty submissions are ignored so a
    // stray enter never fires a pointless chat turn.
    if (key.return) {
      const draft = value.trim();
      if (draft.length > 0) {
        setHistory((prev) => [...prev, draft]);
        setHistoryIndex(-1);
        onSubmit(draft);
      }
      return;
    }

    if (key.backspace) {
      onChange(value.slice(0, -1));
      return;
    }

    // up/down walk the local submit history (recall last message).
    if (key.upArrow && history.length > 0) {
      const index = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(index);
      onChange(history[index] ?? "");
      return;
    }
    if (key.downArrow && historyIndex !== -1) {
      const index = historyIndex + 1;
      if (index >= history.length) {
        setHistoryIndex(-1);
        onChange("");
      } else {
        setHistoryIndex(index);
        onChange(history[index] ?? "");
      }
      return;
    }

    // control sequences and ctrl/meta chords are never text (shift is
    // text: Shift+A is "A"; only empty-input control keys are skipped).
    if (input === "" || key.ctrl || key.meta) return;

    onChange(value + input);
  });

  return (
    <Box>
      <Text color="green">&gt; </Text>
      {value.length > 0 ? (
        <Text>
          {value}
          {focused ? <Text backgroundColor="white" color="black"> </Text> : null}
        </Text>
      ) : (
        <Text dimColor>{placeholder ?? ""} </Text>
      )}
    </Box>
  );
}