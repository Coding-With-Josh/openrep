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

function pickWord(list: readonly string[]): string {
  // four bytes from the same csprng noble uses for keys (webcrypto backed).
  // the modulo bias for lists of length ~36 is far below any adversarial
  // relevance because names are ergonomics, not security; keys never use
  // this path.
  const bytes = etc.randomBytes(4);
  const index = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
  return list[index % list.length];
}

// generates a name in the documented `adjective-noun-color.agent` shape.
export function generateName(): string {
  return `${pickWord(ADJECTIVES)}-${pickWord(NOUNS)}-${pickWord(COLORS)}.agent`;
}