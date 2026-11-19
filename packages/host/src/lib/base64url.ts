/*
 * Unpadded, URL-safe base64, the spelling Web Push uses for keys (RFC 8292).
 * The host stores and compares keys in this form.
 */

/** Bytes as unpadded base64url. */
export function encodeBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** Unpadded (or padded) base64url as bytes; throws on text that is not base64url. */
export function decodeBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const standard = text.replaceAll('-', '+').replaceAll('_', '/');
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.codePointAt(index) ?? 0;
  }
  return bytes;
}
