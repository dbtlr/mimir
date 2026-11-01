/**
 * A stored prose field (a description or `## Next` text) as every read yields
 * it: trimmed, and blank reads as none. A write that echoes what it stored
 * applies the same rule, so the echo equals the next read (MMR-607).
 */
export function storedProse(value: string | null | undefined): string | null {
  const text = (value ?? '').trim();
  return text === '' ? null : text;
}
