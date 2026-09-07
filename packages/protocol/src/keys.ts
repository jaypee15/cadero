export async function importSessionKey(rawBase64Url: string): Promise<CryptoKey> {
  const bytes = Buffer.from(rawBase64Url, "base64url");
  if (bytes.byteLength !== 32) {
    throw new Error("session key must be 32 raw bytes");
  }
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return crypto.subtle.importKey("raw", out, "AES-GCM", true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function exportSessionKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return Buffer.from(new Uint8Array(raw)).toString("base64url");
}
