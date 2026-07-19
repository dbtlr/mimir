/**
 * Presentation primitives shared by every command surface — the `Io` output
 * sink, the `Format` selector, and the small color/glyph helpers command
 * handlers reach for directly. Kept out of `cli/` because `doctor`, `service`,
 * and `vault` command handlers use these too, even though only the CLI
 * transport currently invokes those commands: a presentation primitive isn't
 * a CLI-transport concept. The composed view renderers (`renderTable`,
 * `renderOverview`, and everything built on top of these primitives) stay in
 * `cli/render.ts` — this module is deliberately just the primitives.
 */

export const FORMATS = ['table', 'records', 'ids', 'json', 'jsonl'] as const;
export type Format = (typeof FORMATS)[number];

/** Output sink + presentation context, injected so the CLI is testable. */
export type Io = {
  write: (text: string) => void;
  error: (text: string) => void;
  /** Is stdout a TTY? Drives the format default. */
  isTTY: boolean;
  /** Suppress ANSI (NO_COLOR env or `--ascii`). */
  plain: boolean;
};

/** Wrap `text` in an ANSI color (`plain` — NO_COLOR/--ascii/!isTTY — passes it through untouched). Exported for the help renderer (MMR-300): same plain/color contract, no second color system. */
export function color(text: string, code: number, plain: boolean): string {
  return plain ? text : `\x1b[${String(code)}m${text}\x1b[0m`;
}

/** Wrap `text` in ANSI bold (`plain` passes it through untouched). Exported for the help renderer (MMR-300). */
export function bold(text: string, plain: boolean): string {
  return plain ? text : `\x1b[1m${text}\x1b[0m`;
}

/**
 * The shared status/relation arrow — `→` styled, `->` plain (`--ascii`/NO_COLOR).
 * Arrows carry direction (real information), so they degrade to ASCII while `·`
 * keeps its glyph. Every arrow reads left to right; operands are always ordered
 * old → new (transitions) or subject → destination — never a reversed glyph.
 */
export function arrow(plain: boolean): string {
  return plain ? '->' : '→';
}

/** Success line on stdout — the shared `✓`/`[ok]` glyph (color is decoration). */
export function ok(io: Io, text: string): void {
  const glyph = io.plain ? '[ok]' : '\x1b[32m✓\x1b[0m';
  io.write(`${glyph} ${text}`);
}

/** Warning line on stderr — the shared `⚠`/`[warn]` glyph. */
export function warn(io: Io, text: string): void {
  const glyph = io.plain ? '[warn]' : '\x1b[33m⚠\x1b[0m';
  io.error(`${glyph} ${text}`);
}
