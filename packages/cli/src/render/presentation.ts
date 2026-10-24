import type { ViewContext } from '@loomcli/core';

/**
 * The presentation context the styled views read, and the small glyph and color
 * primitives they compose. A view returns text with raw SGR codes for color;
 * Loom's rendering policy strips them where color is off, and `plain` also
 * swaps each icon for its ASCII form (ADR 0009: color and icons are decoration).
 */

/** How the styled formats render for this invocation. */
export type Presentation = {
  /** No color and ASCII glyphs: `--ascii`, `NO_COLOR`, or a stdout that is not a terminal. */
  plain: boolean;
  /** Is stdout a terminal? Terminal-only prose, such as onward hints, prints only then. */
  isTTY: boolean;
  /** The IANA zone timestamps render in (ADR 0029). */
  zone: string;
};

/** The terminal facts a presentation is read from: Loom's captured host, narrowed. */
export type PresentationHost = {
  env: Readonly<Record<string, string | undefined>>;
  terminal: { stdout: { isTTY: boolean } };
  timeZone: string;
};

/** The presentation for one invocation: `ascii` is the `--ascii` flag, `zone` an explicit `--tz`. */
export function presentationOf(
  host: PresentationHost,
  ascii: boolean,
  zone?: string,
): Presentation {
  const isTTY = host.terminal.stdout.isTTY;
  return {
    isTTY,
    plain: ascii || host.env.NO_COLOR !== undefined || !isTTY,
    zone: zone ?? host.timeZone,
  };
}

/** Wrap `text` in an SGR color, or leave it bare when `plain`. */
export function color(text: string, code: number, plain: boolean): string {
  return plain ? text : `\u001B[${String(code)}m${text}\u001B[0m`;
}

/** Wrap `text` in bold, or leave it bare when `plain`. */
export function bold(text: string, plain: boolean): string {
  return plain ? text : `\u001B[1m${text}\u001B[0m`;
}

/** Wrap `text` in the dim gray of a preview line, or leave it bare when `plain`. */
export function dimmed(text: string, plain: boolean): string {
  return color(text, 90, plain);
}

/** The transition arrow: `→` styled, `->` plain. */
export function arrow(plain: boolean): string {
  return plain ? '->' : '→';
}

/** The warning line's glyph. */
export function warnGlyph(plain: boolean): string {
  return plain ? '[warn]' : '\u001B[33m⚠\u001B[0m';
}

/** The success line's glyph. */
export function okGlyph(plain: boolean): string {
  return plain ? '[ok]' : color('✓', 32, false);
}

/** A success line: the check glyph, then `text`. */
export function okLine(presentation: Presentation, text: string): string {
  return `${okGlyph(presentation.plain)} ${text}`;
}

/** The note label under a warning. */
export function noteLabel(plain: boolean): string {
  return plain ? 'note:' : '\u001B[36mnote:\u001B[0m';
}

/** How many terminal cells `text` takes: wide characters take two. */
export type Measure = (text: string) => number;

/** A presentation as one view renders it: the invocation's facts and Loom's cell measure. */
export type Layout = Presentation & { width: Measure };

/** `p` at a view's destination, measuring text as Loom's `context.width` does. */
export function layoutOf(p: Presentation, context: Pick<ViewContext, 'width'>): Layout {
  return { ...p, width: context.width };
}

/** Right-pad `text` with spaces to `cells` terminal cells, as `width` measures them. */
export function pad(text: string, cells: number, width: Measure): string {
  const taken = width(text);
  return taken >= cells ? text : text + ' '.repeat(cells - taken);
}

/** `${n} task` / `${n} tasks`: the count line that leads every set view. */
export function countLine(n: number, unit: string): string {
  return `${String(n)} ${unit}${n === 1 ? '' : 's'}`;
}
