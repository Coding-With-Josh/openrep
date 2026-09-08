import { etc } from "@noble/ed25519";

// word lists for human readable agent names, exported so tests and callers
// can reason about the alphabet. all lowercase, no duplicates within a list,
// and no word appears in more than one list so a generated name never reads
// like "quiet-quiet-quiet". lists are the documented 30-40 words each.

export const ADJECTIVES: readonly string[] = [
  "beautiful",
  "brave",
  "bright",
  "calm",
  "clever",
  "curious",
  "eager",
  "faithful",
  "gentle",
  "graceful",
  "happy",
  "honest",
  "humble",
  "kind",
  "lively",
  "loyal",
  "lucky",
  "mighty",
  "noble",
  "patient",
  "peaceful",
  "playful",
  "proud",
  "quick",
  "quiet",
  "radiant",
  "rapid",
  "serene",
  "sharp",
  "silent",
  "sincere",
  "swift",
  "tall",
  "wise",
  "young",
  "zealous",
];

export const NOUNS: readonly string[] = [
  "ant",
  "beaver",
  "bee",
  "bird",
  "boar",
  "bunny",
  "cat",
  "crab",
  "deer",
  "dog",
  "dolphin",
  "duck",
  "eagle",
  "falcon",
  "fox",
  "frog",
  "goat",
  "hawk",
  "horse",
  "lion",
  "lynx",
  "mole",
  "monkey",
  "mouse",
  "otter",
  "owl",
  "panda",
  "pig",
  "rabbit",
  "raven",
  "seal",
  "shark",
  "skunk",
  "snake",
  "turtle",
  "wolf",
];

export const COLORS: readonly string[] = [
  "amber",
  "aqua",
  "beige",
  "black",
  "blue",
  "bronze",
  "brown",
  "crimson",
  "cyan",
  "emerald",
  "gold",
  "gray",
  "green",
  "indigo",
  "ivory",
  "lavender",
  "lilac",
  "magenta",
  "maroon",
  "navy",
  "olive",
  "orange",
  "peach",
  "pink",
  "plum",
  "purple",
  "red",
  "rose",
  "ruby",
  "sapphire",
  "scarlet",
  "silver",
  "tan",
  "teal",
  "violet",
  "yellow",
];

function pickIndex(limit: number): number {
  // four bytes from the same csprng noble uses for keys (webcrypto backed).
  // the modulo bias for lists of length ~36 is far below any adversarial
  // relevance because names are ergonomics, not security; keys never use
  // this path.
  const bytes = etc.randomBytes(4);
  const value = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
  return value % limit;
}

function pickWord(list: readonly string[]): string {
  return list[pickIndex(list.length)];
}

// generates a name in the documented `adjective-noun-color.agent` shape.
export function generateName(): string {
  return `${pickWord(ADJECTIVES)}-${pickWord(NOUNS)}-${pickWord(COLORS)}.agent`;
}

// fisher-yates over the csprng draw above, so a reroll cycle never repeats a
// word or an exact name within the same batch. batch size is bounded by the
// shortest word list so the without-replacement guarantee stays honest.
export function generateNameBatch(count: number): string[] {
  const maxBatch = Math.min(ADJECTIVES.length, NOUNS.length, COLORS.length);
  if (!Number.isInteger(count) || count < 1 || count > maxBatch) {
    throw new RangeError(`count must be an integer between 1 and ${maxBatch}`);
  }
  const adjectives = shuffle(ADJECTIVES).slice(0, count);
  const nouns = shuffle(NOUNS).slice(0, count);
  const colors = shuffle(COLORS).slice(0, count);
  return adjectives.map((adjective, i) => `${adjective}-${nouns[i]}-${colors[i]}.agent`);
}

function shuffle(list: readonly string[]): string[] {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = pickIndex(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}