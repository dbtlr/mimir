/** A fresh launch attempt id: 16 random bytes as 22 base64url characters (ADR 0040, Launch). */
export function newAttempt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCodePoint(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
