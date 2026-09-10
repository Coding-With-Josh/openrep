// raw keystroke decoding: turn what ink's useInput reports (a per-keystroke
// `input` string plus a `key` flags object) into a typed edit command for
// input-machine.ts.
//
// the tricky part is that word-wise movement reports differently across
// terminals and operating systems:
//   - macos option+left/right   -> CSI "1;3D"/"1;3C" (or key.meta + arrow)
//   - linux/windows ctrl+left/right -> CSI "1;5D"/"1;5C" (or key.ctrl + arrow)
//   - some terminals send the short CSI "3D"/"5D"/"3C"/"5C" forms
//   - ink on some ttys reports key.leftArrow/key.rightArrow with the ctrl or
//     meta flag set instead of a raw CSI
// the decode layer accepts ALL of these (union, no os branch), and the edit
// layer downstream is the single implementation shared by every platform.
//
// deletion sequences:
//   - option+backspace (macos) -> CSI "127" in iTerm/apple terminal, or
//     key.backspace with key.meta
//   - ctrl+backspace (linux)   -> CSI "3;5~"
//   - cmd+backspace (macos)    -> key.meta + key.backspace (see above); the
//     universal ctrl+u binding is the primary line-start kill everywhere

import type { Key } from "ink";

export type InputCommand =
  | { kind: "insert"; text: string }
  | { kind: "backspace" }
  | { kind: "delete" }
  | { kind: "move-left" }
  | { kind: "move-right" }
  | { kind: "move-word-left" }
  | { kind: "move-word-right" }
  | { kind: "delete-word-left" }
  | { kind: "delete-line-start" }
  | { kind: "delete-line-end" }
  | { kind: "history-previous" }
  | { kind: "history-next" }
  | { kind: "submit" }
  | { kind: "none" };

// csi sequences accepted as word movement or word deletion, both the long
// (1;3 / 1;5) and short (3 / 5) cursor forms. an exact-string decoder keeps
// this table trivially auditable and unit-testable without a pty.
const CSI_WORD_LEFT = new Set(["\x1b[1;3D", "\x1b[1;5D", "\x1b[3D", "\x1b[5D", "\x1b[OD"]);
const CSI_WORD_RIGHT = new Set(["\x1b[1;3C", "\x1b[1;5C", "\x1b[3C", "\x1b[5C", "\x1b[OC"]);
const CSI_PLAIN_LEFT = "\x1b[D";
const CSI_PLAIN_RIGHT = "\x1b[C";
const CSI_WORD_BACKSPACE = new Set(["\x1b[127", "\x1b[3;5~", "\x1b[7~"]);

export interface DecodedKey {
  input: string;
  key: Key;
}

export function decodeInput(input: string, key: Key): InputCommand {
  // submit
  if (key.return) return { kind: "submit" };

  // backspace variants: word kill when the terminal reported a word-delete
  // sequence (some terminals send the csi alone, without a backspace flag)
  // or a meta chord, plain backspace otherwise.
  if (CSI_WORD_BACKSPACE.has(input)) return { kind: "delete-word-left" };
  if (key.backspace || input === "\x7f") {
    if (key.meta) return { kind: "delete-word-left" };
    return { kind: "backspace" };
  }

  // line-start kill: ctrl+u (readline standard, works everywhere), which ink
  // hands over as the NAK control char or as ctrl+u.
  if (key.ctrl && (input === "u" || input === "\u0015")) return { kind: "delete-line-start" };
  // line-end kill: ctrl+k, the natural complement (VT control char).
  if (key.ctrl && (input === "k" || input === "\u000b")) return { kind: "delete-line-end" };

  // arrows. order matters: check the raw csi sequences first (they may
  // arrive with key.leftArrow/key.rightArrow unset on some ttys), then the
  // key flags.
  if (CSI_WORD_LEFT.has(input)) return { kind: "move-word-left" };
  if (CSI_WORD_RIGHT.has(input)) return { kind: "move-word-right" };
  if (CSI_PLAIN_LEFT === input) return { kind: "move-left" };
  if (CSI_PLAIN_RIGHT === input) return { kind: "move-right" };

  if (key.leftArrow) {
    return key.ctrl || key.meta ? { kind: "move-word-left" } : { kind: "move-left" };
  }
  if (key.rightArrow) {
    return key.ctrl || key.meta ? { kind: "move-word-right" } : { kind: "move-right" };
  }

  // input history recall on the chat prompt.
  if (key.upArrow) return { kind: "history-previous" };
  if (key.downArrow) return { kind: "history-next" };

  // printable text: one character, no control flags. shift chords arrive as
  // the shifted character itself (Shift+A is "A"). esc and ctrl/meta chords
  // are never text, and an unmatched escape sequence (a CSI we do not
  // recognize) is dropped rather than spliced into the edit buffer.
  if (input === "" || key.ctrl || key.meta || key.escape || input.startsWith("\x1b")) {
    return { kind: "none" };
  }

  return { kind: "insert", text: input };
}