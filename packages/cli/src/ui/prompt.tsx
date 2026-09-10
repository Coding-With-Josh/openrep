// the single-line text input shared by the chat and (indirectly) any prompt
// surface. ink v7 has no built-in TextInput, so this is ours: a controlled
// input box rendered as "> " + value + a block cursor, driven by useInput.
//
// editing is a real cursor machine, not a readline shim: raw keystrokes are
// decoded by input-keys.ts into commands (accepting both the macos option-
// arrow and the linux/windows ctrl-arrow variants), and input-machine.ts
// applies them to a { value, cursor } state. word moves and line kills are
// the readline conventions (option/ctrl+arrow word jump, option/ctrl+
// backspace word delete, ctrl+u kill to line start, ctrl+k kill to line
// end). the up/down arrow recall of submitted messages is preserved.
//
// screen-level keys (esc back, ctrl+r retry) are NOT consumed here: ink
// dispatches every keystroke to every useInput hook, so the parent screen
// still sees them while this prompt is focused.
//
// secret mode (provider api key prompt) keeps the deliberately narrow
// surface of its predecessor: append + backspace only, no cursor movement,
// and no recall history, so a pasted key cannot be redisplayed by an arrow
// press or remain visible mid-edit.

import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";

import { decodeInput } from "./input-keys.js";
import {
  deleteAtCursorLeft,
  deleteLineEnd,
  deleteLineStart,
  deleteWordLeft,
  insertText,
  moveLeft,
  moveRight,
  moveWordLeft,
  moveWordRight,
  type InputState,
} from "./input-machine.js";

export interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  focused: boolean;
  // secret mode masks every character (provider api key prompt). the raw
  // value stays in the parent's state, but the render tree only ever paints
  // the mask, and secret inputs never join the recall history so a pasted
  // key cannot be redisplayed by an arrow press.
  secret?: boolean;
}

export function PromptInput({ value, onChange, onSubmit, placeholder, focused, secret = false }: PromptInputProps) {
  const [cursor, setCursor] = useState<number>(value.length);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);

  // the last value this component itself produced. when the parent changes
  // `value` some other way (submit clears the draft, retry restores text,
  // tests set state directly), the cursor jumps to the end of the new
  // value, like every real shell. when the change came from our own edit,
  // the cursor stays exactly where our edit put it.
  const lastProduced = useRef<string | null>(null);

  useEffect(() => {
    if (value !== lastProduced.current) {
      setCursor(value.length);
    }
    lastProduced.current = null;
  }, [value]);

  // apply one edit command: record the produced value, report it, and keep
  // the cursor in sync. lastProduced must be set BEFORE onChange so the
  // effect above does not reset the cursor when the prop round-trips.
  function apply(state: InputState) {
    lastProduced.current = state.value;
    onChange(state.value);
    setCursor(state.cursor);
  }

  useInput((input, key) => {
    if (!focused) return;

    // enter submits the current draft. empty submissions are ignored so a
    // stray enter never fires a pointless chat turn.
    if (key.return) {
      const draft = value.trim();
      if (draft.length > 0) {
        if (!secret) {
          setHistory((prev) => [...prev, draft]);
          setHistoryIndex(-1);
        }
        onSubmit(draft);
      }
      return;
    }

    // secret mode: append + backspace only, always at the end of the line.
    // no word kills or line kills here: the key prompt is a paste surface,
    // and its mask never reveals edit position or content.
    if (secret) {
      if (key.backspace && !key.meta) {
        onChange(value.slice(0, -1));
        return;
      }
      if (input === "" || key.ctrl || key.meta) return;
      onChange(value + input);
      return;
    }

    if (key.upArrow) {
      if (history.length === 0) return;
      const index = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(index);
      const recalled = history[index] ?? "";
      lastProduced.current = recalled;
      onChange(recalled);
      setCursor(recalled.length);
      return;
    }
    if (key.downArrow) {
      if (historyIndex === -1) return;
      const index = historyIndex + 1;
      if (index >= history.length) {
        setHistoryIndex(-1);
        const cleared = "";
        lastProduced.current = cleared;
        onChange(cleared);
        setCursor(0);
      } else {
        setHistoryIndex(index);
        const recalled = history[index] ?? "";
        lastProduced.current = recalled;
        onChange(recalled);
        setCursor(recalled.length);
      }
      return;
    }

    // left/right arrows and the csi variants are decoded here so the exact
    // same edit semantics apply on macos (option) and linux/windows (ctrl).
    const command = decodeInput(input, key);
    switch (command.kind) {
      case "insert":
        apply(insertText({ value, cursor }, command.text));
        return;
      case "backspace":
        apply(deleteAtCursorLeft({ value, cursor }));
        return;
      case "move-left":
        apply(moveLeft({ value, cursor }));
        return;
      case "move-right":
        apply(moveRight({ value, cursor }));
        return;
      case "move-word-left":
        apply(moveWordLeft({ value, cursor }));
        return;
      case "move-word-right":
        apply(moveWordRight({ value, cursor }));
        return;
      case "delete-word-left":
        apply(deleteWordLeft({ value, cursor }));
        return;
      case "delete-line-start":
        apply(deleteLineStart({ value, cursor }));
        return;
      case "delete-line-end":
        apply(deleteLineEnd({ value, cursor }));
        return;
      // submit/history are handled above; everything else (esc, ctrl/meta
      // chords other than the edits above) is deliberately not consumed so
      // the parent screen can act on it.
      case "submit":
      case "history-previous":
      case "history-next":
      case "none":
        return;
    }
  });

  const display = secret ? "●".repeat(value.length) : value;

  return (
    <Box>
      <Text color="green">&gt; </Text>
      {value.length > 0 ? (
        <Text>
          {display.slice(0, cursor)}
          {focused && !secret ? <Text backgroundColor="white" color="black"> </Text> : null}
          {display.slice(cursor)}
          {secret && focused ? <Text backgroundColor="white" color="black"> </Text> : null}
        </Text>
      ) : (
        <Text dimColor>{placeholder ?? ""} </Text>
      )}
    </Box>
  );
}