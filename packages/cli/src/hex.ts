// local hex helpers, mirroring the sdk's internal hex module. the sdk does
// not export these (they are implementation details there), so the cli keeps
// its own small copies rather than reaching into sdk internals.

export function isLowercaseHexOfLength(value: unknown, byteLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length === byteLength * 2 &&
    /^[0-9a-f]+$/.test(value)
  );
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function isEd25519PrivateKeyHex(value: unknown): value is string {
  return isLowercaseHexOfLength(value, 32);
}