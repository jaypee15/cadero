import { base64UrlToBytes, bytesToBase64Url } from "./envelope.js";

export async function importSessionKey(rawBase64Url: string): Promise<CryptoKey> {
  const bytes = base64UrlToBytes(rawBase64Url);
  if (bytes.byteLength !== 32) {
    throw new Error("session key must be 32 raw bytes");
  }
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function exportSessionKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return bytesToBase64Url(new Uint8Array(raw));
}
