import { validation } from '../errors';

/**
 * The seed capture grammar (MMR-263) — one text blob with commit-message
 * semantics, single-sourced so the CLI, MCP, HTTP, and the console popover all
 * split and cap identically (ADR 0021).
 *
 * The first line is the title (the lede); the rest, after the first newline, is
 * the `## Seed Description` body. An explicit description wins over the split
 * body. A first line longer than {@link SEED_TITLE_CAP} ERRORS with copy that
 * teaches the split — the forcing function that keeps prose out of the title.
 */

/** The hard title cap — a first line longer than this errors. Chosen to admit a
 * real one-line summary while forcing anything longer into the body. */
export const SEED_TITLE_CAP = 120;

/**
 * Split a capture blob into `{ title, description }` at the FIRST newline: the
 * first line (trimmed) is the title, the remainder (trimmed, inner newlines
 * kept) is the body. An `explicitDescription` — when provided (not `undefined`)
 * — wins over the split body; an empty/blank one clears it to `null`. A blob with
 * no newline is a title-only capture (its body comes from the explicit
 * description, or is `null`).
 */
export function splitCapture(
  blob: string,
  explicitDescription?: string | null,
): { title: string; description: string | null } {
  const newline = blob.indexOf('\n');
  const title = (newline === -1 ? blob : blob.slice(0, newline)).trim();
  const splitBody = newline === -1 ? '' : blob.slice(newline + 1).trim();
  // An explicit description (any non-undefined value) wins over the split body; a
  // blank one clears the body to null.
  if (explicitDescription === undefined) {
    return { description: splitBody === '' ? null : splitBody, title };
  }
  const explicit = explicitDescription ?? '';
  return { description: explicit.trim() === '' ? null : explicitDescription, title };
}

/**
 * The hard title shape (MMR-263) — a title is ONE line under {@link
 * SEED_TITLE_CAP} characters; anything else errors with copy teaching the split.
 * Shared by seed filing and `update --title` so the rule is uniform: filing can
 * never pass a newline here ({@link splitCapture} takes the first line), but
 * `update --title` hands the raw value through, so the single-line rule is
 * asserted here too — a multi-line title would defeat the forcing function.
 */
export function assertTitleWithinCap(title: string): void {
  if (title.includes('\n')) {
    throw validation(
      'a seed title is one line — the title is the lede',
      'put the rest in the description (the first newline splits title from body on filing)',
    );
  }
  if (title.length > SEED_TITLE_CAP) {
    throw validation(
      `the first line is the title (the lede), and it is ${String(title.length)} characters — the cap is ${String(SEED_TITLE_CAP)}`,
      'put the body on the next line (the first newline splits title from body), or pass an explicit description',
    );
  }
}
