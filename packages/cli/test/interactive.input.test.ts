// the chat input editing stack: the pure cursor/edit machine
// (input-machine.ts), the keystroke decoder (input-keys.ts), and the chat
// history slice used for the next wrapAgent turn (interactive.tsx). all of
// it is deterministic, so it gets the full unit-test pass: cursor and word
// semantics are the readline conventions, and the decoder is tested for
// BOTH operating-system spellings of word movement (macos option+arrow and
// linux/windows ctrl+arrow), since the whole point of the machine is that
// edits behave identically everywhere.

import { describe, expect, it } from "vitest";

import {
  deleteAtCursorLeft,
  deleteAtCursorRight,
  deleteLineEnd,
  deleteLineStart,
  deleteWordLeft,
  insertText,
  moveLeft,
  moveRight,
  moveWordLeft,
  moveWordRight,
  nextWordBoundary,
  previousWordBoundary,
  replaceAll,
} from "../src/ui/input-machine.js";
import { decodeInput } from "../src/ui/input-keys.js";
import { chatTurnParams, historySliceForTurn } from "../src/interactive.js";
import { renderMarkdownToAnsi } from "../src/ui/markdown.js";

// a minimal ink Key stub so tests name only the flags they assert.
function k(flags: Record<string, boolean> = {}): any {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    return: false,
    escape: false,
    ctrl: false,
    meta: false,
    shift: false,
    tab: false,
    delete: false,
    backspace: false,
    ...flags,
  };
}

describe("input-machine: cursor movement", () => {
  it("moves left and right one character, clamped at the ends", () => {
    expect(moveLeft({ value: "ab", cursor: 2 })).toEqual({ value: "ab", cursor: 1 });
    expect(moveLeft({ value: "ab", cursor: 0 })).toEqual({ value: "ab", cursor: 0 });
    expect(moveRight({ value: "ab", cursor: 0 })).toEqual({ value: "ab", cursor: 1 });
    expect(moveRight({ value: "ab", cursor: 2 })).toEqual({ value: "ab", cursor: 2 });
  });

  it("finds readline word boundaries (spaces delimit words)", () => {
    expect(previousWordBoundary("hello world there", 17)).toBe(12); // "there"
    expect(previousWordBoundary("hello world there", 12)).toBe(6); // "world"
    expect(previousWordBoundary("hello world", 0)).toBe(0);
    expect(previousWordBoundary("hello  world", 12)).toBe(7); // double space collapses
    expect(nextWordBoundary("hello world there", 0)).toBe(5);
    expect(nextWordBoundary("hello world there", 6)).toBe(11);
    expect(nextWordBoundary("hello world", 5)).toBe(11); // skips the space run
    expect(nextWordBoundary("hello", 3)).toBe(5);
  });

  it("word-left and word-right jump across words and whitespace", () => {
    expect(moveWordLeft({ value: "hello world", cursor: 11 })).toEqual({ value: "hello world", cursor: 6 });
    expect(moveWordRight({ value: "hello world", cursor: 0 })).toEqual({ value: "hello world", cursor: 5 });
    expect(moveWordRight({ value: "hello world", cursor: 6 })).toEqual({ value: "hello world", cursor: 11 });
  });
});

describe("input-machine: editing", () => {
  it("inserts at the cursor, not at the end", () => {
    expect(insertText({ value: "ac", cursor: 1 }, "b")).toEqual({ value: "abc", cursor: 2 });
    expect(insertText({ value: "ab", cursor: 2 }, "c")).toEqual({ value: "abc", cursor: 3 });
    expect(insertText({ value: "", cursor: 0 }, "hi")).toEqual({ value: "hi", cursor: 2 });
  });

  it("backspace deletes left of the cursor, no-op at the start", () => {
    expect(deleteAtCursorLeft({ value: "abc", cursor: 2 })).toEqual({ value: "ac", cursor: 1 });
    expect(deleteAtCursorLeft({ value: "abc", cursor: 0 })).toEqual({ value: "abc", cursor: 0 });
  });

  it("forward delete removes the char at the cursor, no-op at the end", () => {
    expect(deleteAtCursorRight({ value: "abc", cursor: 1 })).toEqual({ value: "ac", cursor: 1 });
    expect(deleteAtCursorRight({ value: "abc", cursor: 3 })).toEqual({ value: "abc", cursor: 3 });
  });

  it("word delete removes the word behind the cursor (option/ctrl+backspace)", () => {
    expect(deleteWordLeft({ value: "hello world", cursor: 11 })).toEqual({ value: "hello ", cursor: 6 });
    expect(deleteWordLeft({ value: "hello  world", cursor: 12 })).toEqual({ value: "hello  ", cursor: 7 });
    expect(deleteWordLeft({ value: "alone", cursor: 5 })).toEqual({ value: "", cursor: 0 });
  });

  it("ctrl+u kills to line start, keeping the after-cursor text", () => {
    expect(deleteLineStart({ value: "keep me", cursor: 4 })).toEqual({ value: " me", cursor: 0 });
    expect(deleteLineStart({ value: "all", cursor: 3 })).toEqual({ value: "", cursor: 0 });
  });

  it("ctrl+k kills to line end, keeping the before-cursor text", () => {
    expect(deleteLineEnd({ value: "keep me", cursor: 4 })).toEqual({ value: "keep", cursor: 4 });
    expect(deleteLineEnd({ value: "all", cursor: 0 })).toEqual({ value: "", cursor: 0 });
  });

  it("replaceAll (history recall / external set) jumps the cursor to the end", () => {
    expect(replaceAll({ value: "old", cursor: 0 }, "new message")).toEqual({ value: "new message", cursor: 11 });
  });
});

describe("input-keys: basic keys", () => {
  it("inserts printable input, including shifted characters", () => {
    expect(decodeInput("a", k())).toEqual({ kind: "insert", text: "a" });
    expect(decodeInput("A", k({ shift: true }))).toEqual({ kind: "insert", text: "A" });
    expect(decodeInput("?", k({ shift: true }))).toEqual({ kind: "insert", text: "?" });
  });

  it("submits on enter only", () => {
    expect(decodeInput("", k({ return: true }))).toEqual({ kind: "submit" });
  });

  it("never treats control chords or esc as text", () => {
    expect(decodeInput("r", k({ ctrl: true }))).toEqual({ kind: "none" }); // ctrl+r retry stays screen-level
    expect(decodeInput("\u0012", k({ ctrl: true }))).toEqual({ kind: "none" });
    expect(decodeInput("", k({ escape: true }))).toEqual({ kind: "none" });
    expect(decodeInput("\u001b[A", k())).toEqual({ kind: "none" }); // unknown csi is dropped
    expect(decodeInput("", k())).toEqual({ kind: "none" });
  });
});

describe("input-keys: backspace variants", () => {
  it("plain backspace deletes a character", () => {
    expect(decodeInput("", k({ backspace: true }))).toEqual({ kind: "backspace" });
    expect(decodeInput("\x7f", k())).toEqual({ kind: "backspace" });
  });

  it("word delete arrives as meta+backspace (macos) or ctrl+backspace csi (linux)", () => {
    expect(decodeInput("", k({ backspace: true, meta: true }))).toEqual({ kind: "delete-word-left" });
    expect(decodeInput("\x1b[3;5~", k())).toEqual({ kind: "delete-word-left" });
    expect(decodeInput("\x1b[127", k())).toEqual({ kind: "delete-word-left" });
  });
});

describe("input-keys: line kills", () => {
  it("ctrl+u kills to line start, as either the letter or its control char", () => {
    expect(decodeInput("u", k({ ctrl: true }))).toEqual({ kind: "delete-line-start" });
    expect(decodeInput("\u0015", k({ ctrl: true }))).toEqual({ kind: "delete-line-start" });
  });

  it("ctrl+k kills to line end, as either the letter or its control char", () => {
    expect(decodeInput("k", k({ ctrl: true }))).toEqual({ kind: "delete-line-end" });
    expect(decodeInput("\u000b", k({ ctrl: true }))).toEqual({ kind: "delete-line-end" });
  });
});

describe("input-keys: arrows and word movement across platforms", () => {
  it("plain arrows move one character", () => {
    expect(decodeInput("", k({ leftArrow: true }))).toEqual({ kind: "move-left" });
    expect(decodeInput("", k({ rightArrow: true }))).toEqual({ kind: "move-right" });
    expect(decodeInput("\x1b[D", k())).toEqual({ kind: "move-left" });
    expect(decodeInput("\x1b[C", k())).toEqual({ kind: "move-right" });
  });

  it("macos option+arrow and linux/windows ctrl+arrow both move by word", () => {
    // option+arrow long csi forms
    expect(decodeInput("\x1b[1;3D", k())).toEqual({ kind: "move-word-left" });
    expect(decodeInput("\x1b[1;3C", k())).toEqual({ kind: "move-word-right" });
    // ctrl+arrow long csi forms
    expect(decodeInput("\x1b[1;5D", k())).toEqual({ kind: "move-word-left" });
    expect(decodeInput("\x1b[1;5C", k())).toEqual({ kind: "move-word-right" });
    // short csi forms some terminals send
    expect(decodeInput("\x1b[3D", k())).toEqual({ kind: "move-word-left" });
    expect(decodeInput("\x1b[5D", k())).toEqual({ kind: "move-word-left" });
    expect(decodeInput("\x1b[3C", k())).toEqual({ kind: "move-word-right" });
    expect(decodeInput("\x1b[5C", k())).toEqual({ kind: "move-word-right" });
    // sgr-less legacy forms
    expect(decodeInput("\x1b[OD", k())).toEqual({ kind: "move-word-left" });
    expect(decodeInput("\x1b[OC", k())).toEqual({ kind: "move-word-right" });
    // ink key-flag form
    expect(decodeInput("", k({ leftArrow: true, ctrl: true }))).toEqual({ kind: "move-word-left" });
    expect(decodeInput("", k({ leftArrow: true, meta: true }))).toEqual({ kind: "move-word-left" });
    expect(decodeInput("", k({ rightArrow: true, ctrl: true }))).toEqual({ kind: "move-word-right" });
  });

  it("up/down arrows remain history recall", () => {
    expect(decodeInput("", k({ upArrow: true }))).toEqual({ kind: "history-previous" });
    expect(decodeInput("", k({ downArrow: true }))).toEqual({ kind: "history-next" });
  });
});

describe("history slice for the next turn", () => {
  const entries = [
    { role: "user" as const, content: "first question", toolsUsed: [] },
    {
      role: "assistant" as const,
      content: "first answer",
      toolsUsed: [{ tool: "fetch" as const, input: { url: "x" } }],
      attestationId: "a1a1".repeat(8),
    },
    { role: "user" as const, content: "second question", toolsUsed: [] },
  ];

  it("drops the trailing user entry when it equals the current task (handleSend push-before-run)", () => {
    const history = historySliceForTurn(entries, "second question");
    expect(history).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ]);
  });

  it("is idempotent when the current entry is NOT present yet (stale state before flush)", () => {
    const beforePush = entries.slice(0, 2);
    expect(historySliceForTurn(beforePush, "second question")).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ]);
  });

  it("keeps a deliberately repeated message when it is not the trailing entry", () => {
    const withRepeat = [
      { role: "user" as const, content: "same", toolsUsed: [] },
      { role: "assistant" as const, content: "answer", toolsUsed: [] },
      { role: "user" as const, content: "same", toolsUsed: [] },
    ];
    expect(historySliceForTurn(withRepeat, "same")).toEqual([
      { role: "user", content: "same" },
      { role: "assistant", content: "answer" },
    ]);
  });

  it("keeps a trailing assistant reply in context and never exposes tool input or attestation ids", () => {
    const withTail = [...entries, { role: "assistant" as const, content: "dangling reply", toolsUsed: [] }];
    const history = historySliceForTurn(withTail, "second question");
    expect(history).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second question" },
      { role: "assistant", content: "dangling reply" },
    ]);
    for (const turn of history) {
      expect(turn).not.toHaveProperty("toolsUsed");
      expect(turn).not.toHaveProperty("attestationId");
    }
  });

  it("caps at the sdk MAX_HISTORY_TURNS", () => {
    const many: { role: "user" | "assistant"; content: string; toolsUsed: [] }[] = [];
    for (let i = 0; i < 30; i += 1) {
      many.push({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}`, toolsUsed: [] });
    }
    // trailing user entry equals none of the texts, so nothing is dropped.
    expect(historySliceForTurn(many, "current task").length).toBe(20);
  });

  it("chatTurnParams pairs the task with the bounded history", () => {
    expect(chatTurnParams([], "new task")).toEqual({ task: "new task", history: [] });
    const params = chatTurnParams(entries, "new task");
    expect(params.task).toBe("new task");
    expect(params.history).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second question" },
    ]);
  });
});

describe("markdown renderer", () => {
  it("strips heading markers and renders text structure without markdown syntax", () => {
    const out = renderMarkdownToAnsi("# big heading\n\n**bold** and `code`");
    expect(out).not.toContain("# big heading");
    expect(out).not.toContain("**bold**");
    expect(out).toContain("bold");
    // ansi styling may be present (tty) or stripped (piped chalk), but the
    // structural content is stable either way.
  });

  it("renders code blocks and list items as distinct text", () => {
    const out = renderMarkdownToAnsi("- one\n- two\n\n```js\nconsole.log(1)\n```");
    expect(out).toContain("one");
    expect(out).toContain("two");
    expect(out).toContain("console.log(1)");
  });

  it("renders links with their text and target", () => {
    const out = renderMarkdownToAnsi("[openrep docs](https://openrep.dev)");
    expect(out).toContain("openrep docs");
    expect(out).toContain("https://openrep.dev");
  });
});