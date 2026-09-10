// the pure input editing state machine for the chat prompt. editing logic
// is byte-identical on every platform: decoding raw keystrokes into edit
// commands lives in input-keys.ts, THIS module only applies commands to a
// { value, cursor } pair, so there is exactly one implementation of
// cursor/insert/delete semantics, tested against both key-name variants
// (option on macos, ctrl on linux/windows).
//
// cursor semantics are a plain insert cursor: 0 <= cursor <= value.length.

export interface InputState {
  value: string;
  cursor: number;
}

export const emptyInput: InputState = { value: "", cursor: 0 };

// --- cursor movement -------------------------------------------------------

// readline-style word boundary left of `from`: skip a run of spaces, then
// skip the word before the cursor. returns the index of the word start.
export function previousWordBoundary(value: string, from: number): number {
  let cursor = from;
  while (cursor > 0 && value[cursor - 1] === " ") cursor -= 1;
  while (cursor > 0 && value[cursor - 1] !== " ") cursor -= 1;
  return cursor;
}

// readline-style word boundary right of `from`: skip a run of spaces, then
// skip the word ahead of the cursor. returns the index after the word.
export function nextWordBoundary(value: string, from: number): number {
  let cursor = from;
  const len = value.length;
  while (cursor < len && value[cursor] === " ") cursor += 1;
  while (cursor < len && value[cursor] !== " ") cursor += 1;
  return cursor;
}

export function moveLeft(state: InputState): InputState {
  return { ...state, cursor: Math.max(0, state.cursor - 1) };
}

export function moveRight(state: InputState): InputState {
  return { ...state, cursor: Math.min(state.value.length, state.cursor + 1) };
}

export function moveWordLeft(state: InputState): InputState {
  return { ...state, cursor: previousWordBoundary(state.value, state.cursor) };
}

export function moveWordRight(state: InputState): InputState {
  return { ...state, cursor: nextWordBoundary(state.value, state.cursor) };
}

// --- editing ---------------------------------------------------------------

// insert at the cursor (not append): everything after the cursor shifts
// right, the cursor lands after the inserted text.
export function insertText(state: InputState, text: string): InputState {
  const value = state.value.slice(0, state.cursor) + text + state.value.slice(state.cursor);
  return { value, cursor: state.cursor + text.length };
}

export function deleteAtCursorLeft(state: InputState): InputState {
  if (state.cursor === 0) return state;
  return {
    value: state.value.slice(0, state.cursor - 1) + state.value.slice(state.cursor),
    cursor: state.cursor - 1,
  };
}

export function deleteAtCursorRight(state: InputState): InputState {
  if (state.cursor >= state.value.length) return state;
  return {
    value: state.value.slice(0, state.cursor) + state.value.slice(state.cursor + 1),
    cursor: state.cursor,
  };
}

// option+backspace (macos) / ctrl+backspace (linux/windows): delete the word
// behind the cursor, readline-style.
export function deleteWordLeft(state: InputState): InputState {
  const boundary = previousWordBoundary(state.value, state.cursor);
  return {
    value: state.value.slice(0, boundary) + state.value.slice(state.cursor),
    cursor: boundary,
  };
}

// ctrl+u (and cmd+backspace on macos): kill from the cursor back to the
// start of the line. readline calls this a kill; for a plain prompt the
// killed text is discarded, the after-cursor text shifts to the front.
export function deleteLineStart(state: InputState): InputState {
  return { value: state.value.slice(state.cursor), cursor: 0 };
}

// ctrl+k: kill from the cursor to the end of the line.
export function deleteLineEnd(state: InputState): InputState {
  return { value: state.value.slice(0, state.cursor), cursor: state.cursor };
}

// history recall / external replace: cursor jumps to the end of the new
// value, matching every real shell.
export function replaceAll(state: InputState, value: string): InputState {
  return { value, cursor: value.length };
}