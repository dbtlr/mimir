/**
 * The text rules a transition's log row and stored prose share (MMR-153,
 * MMR-167, MMR-320): the canonical LF line ending, and the one-line,
 * separator-free form a resume handle must take to ride a transition's echo.
 *
 * A boundary that moves the resume handles (ADR 0026 Decision 3: `start` stamps
 * them, the terminal/hold verbs clear them) echoes them as a ` · key=value` tail
 * in canonical key order, so a handle value must carry neither a newline nor the
 * separator — either would forge an additional, never-set handle in the log
 * whose whole purpose is claim succession.
 */

/**
 * Normalize a body to the canonical LF line ending (MMR-167): a `\r\n` (a
 * Windows editor, or git `autocrlf`) is structural, not content, so content
 * authored with embedded CRLF is stored and read back as LF. Use it before
 * comparing two bodies for equality so a CRLF twin reads as identical (MMR-172).
 */
export function toCanonicalLf(body: string): string {
  return body.split(/\r?\n/).join('\n');
}

/**
 * The separator between the edge and each resume-handle pair, and between the
 * pairs themselves (MMR-320). The middle dot with surrounding spaces is the
 * house's own list glyph (the CLI echo uses it), and it never occurs in a
 * machine-written edge value.
 */
export const HANDLE_SEP = ' · ';

/**
 * Can this value ride the echo verbatim? Exactly "flattening changes nothing".
 * The write path REFUSES a value that fails this; the echo path FLATTENS
 * whatever the store already holds ({@link flattenHandle}).
 */
export function isEchoSafeHandle(value: string): boolean {
  return flattenHandle(value) === value;
}

/**
 * Force a value into the one-line, separator-free form the echo can carry
 * losslessly: whitespace runs collapse to a single space, the separator
 * collapses to a single space, and the result is trimmed. Idempotent, so
 * {@link isEchoSafeHandle} is exactly "flattening changes nothing".
 */
export function flattenHandle(value: string): string {
  return value.replace(/\s+/g, ' ').replaceAll(HANDLE_SEP, ' ').replace(/\s+/g, ' ').trim();
}
