// minimal hex codecs plus a strict lowercase validator. `bytesToHex` and
// `hexToBytes` back every key and signature in the sdk, keyed off the
// confirmed convention that all encoded material is lowercase hex. the
// validator exists because `verifyManifest` receives untrusted manifests and
// must reject malformed encodings with a reason instead of letting a loose
// parser guess.
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

// assumes the input passed `isLowercaseHexOfLength` first or was produced by
// `bytesToHex`, callers in this module guarantee that before converting.
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// strict check: exact byte length and only [0-9a-f]. rejects uppercase and
// mixed case, keeping encodings canonical. this is a shape guard against
// crafted manifests (adversarial review: signature malleability), not a
// performance path.
export function isLowercaseHexOfLength(value: string, byteLength: number): boolean {
  if (value.length !== byteLength * 2) return false;
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    const isDigit = code >= 48 && code <= 57;
    const isLowerAlpha = code >= 97 && code <= 102;
    if (!isDigit && !isLowerAlpha) return false;
  }
  return true;
}