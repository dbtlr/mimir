// Reads the console's sources to check their class lists.
// oxlint-disable-next-line import/no-nodejs-modules
import { readdirSync, readFileSync } from 'node:fs';
// oxlint-disable-next-line import/no-nodejs-modules
import { join, relative } from 'node:path';

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StatusBadge, StatusWord } from '../components/status-badge';
import { STATUS_META, STATUS_ORDER } from '../lib/status';

/**
 * Readable type (ADR 0019, MMR-718): nothing that carries information is under
 * 12px, and information text is `ink-dim` or brighter. The token and rule cases
 * read styles.css; the source scan reads every console source file, so a faint
 * or undersized class that returns fails here before it ships.
 */
/** The console's sources, from the package root the tests run in. */
const SRC = 'src';
/** styles.css without its comments, so prose about a size is not read as one. */
const STYLES = readFileSync(join(SRC, 'styles.css'), 'utf8').replaceAll(/\/\*[\s\S]*?\*\//g, '');

/** The floor, and the meta size a relative (em, %) size is read against. */
const FLOOR_PX = 12;
const META_PX = 13;
const PX_PER: Record<string, number> = { pt: 4 / 3, px: 1, rem: 16 };
const SMALL_KEYWORDS = new Set(['small', 'smaller', 'x-small', 'xx-small']);
const READABLE_KEYWORDS = new Set([
  'inherit',
  'initial',
  'large',
  'larger',
  'medium',
  'revert',
  'unset',
  'x-large',
  'xx-large',
  'xxx-large',
]);

/** An absolute size (px, rem, pt) in px, or undefined when the value is not one. */
function absolutePx(value: string): number | undefined {
  const match = /^([\d.]+)(px|rem|pt)$/.exec(value.trim());
  return match === null ? undefined : Number(match[1]) * (PX_PER[match[2] ?? ''] ?? Number.NaN);
}

/**
 * Whether a font size renders under the floor. An em or % size is read against
 * the 13px meta base; `max(N, …)` reads its first argument, the floor
 * markdown-body.tsx sets on its relative sizes; anything it cannot read counts
 * as undersized, so an unreadable size fails loudly rather than slipping past.
 * Known limit: an em or % size is read against 13px, so `0.95em` inside a 12px
 * parent (11.4px) passes; a relative size under the meta base needs a `max()`.
 */
function isUndersized(value: string): boolean {
  const size = value.trim().replace(/^length:/, '');
  const px = absolutePx(size);
  if (px !== undefined) {
    return px < FLOOR_PX;
  }
  const scaled = /^([\d.]+)(em|%)$/.exec(size);
  if (scaled !== null) {
    const ratio = Number(scaled[1]) / (scaled[2] === '%' ? 100 : 1);
    return ratio < FLOOR_PX / META_PX;
  }
  if (SMALL_KEYWORDS.has(size) || READABLE_KEYWORDS.has(size)) {
    return SMALL_KEYWORDS.has(size);
  }
  const fn = /^(max|calc)\((.*)\)$/.exec(size);
  if (fn?.[1] === 'max') {
    const first = absolutePx(fn[2]?.split(',')[0] ?? '');
    return first === undefined || first < FLOOR_PX;
  }
  if (fn?.[1] === 'calc') {
    return isUndersized(fn[2] ?? '');
  }
  return true;
}

/** An arbitrary `text-[…]` value Tailwind reads as a colour, not a size. */
const COLOR_VALUE = /^(?:#|color:|var\(|rgba?\(|hsla?\(|okl(?:ch|ab)\(|color-mix\()/;

/**
 * Every `--text-<step>` declaration in styles.css, the theme's and any scoped
 * redeclaration alike, as `[name, value]` (sub-properties such as
 * `--line-height` excluded).
 */
function typeTokens(): [string, string][] {
  const tokens: [string, string][] = [];
  for (const match of STYLES.matchAll(/--text-([\w-]+?)\s*:\s*([^;}]+)/g)) {
    const name = match[1] ?? '';
    if (!name.includes('--')) {
      tokens.push([name, (match[2] ?? '').trim()]);
    }
  }
  return tokens;
}

/**
 * Faint text and literal sizes. A variant prefix (`placeholder:`, `hover:`,
 * `md:`) still counts: what it styles is text. Faint text takes three forms:
 * the utility, the CSS-variable shorthand, and an arbitrary `var(…)`.
 */
const FAINT_TEXT =
  /(?<![\w-])(?:text-(?:ink-(?:faint|ghost)(?![\w-])|\((?:color:)?--color-ink-(?:faint|ghost)\)|\[(?:color:)?var\(--color-ink-(?:faint|ghost)\)\])|\[color:var\(--color-ink-(?:faint|ghost)\)\])/g;
/** A literal size: the `text-[…]` utility or an arbitrary `[font-size:…]` property. */
const LITERAL_SIZE = /(?<![\w-])(?:text-\[([^\]\s]+)\]|\[font-size:([^\]\s]+)\])/g;
/** An inline style's size or faint colour: `fontSize: 10`, `fontSize: '10px'`, `color: 'var(--color-ink-faint)'`. */
const INLINE_SIZE = /fontSize\s*:\s*(?:['"`]([^'"`]+)['"`]|([\d.]+))/g;
const INLINE_FAINT = /color\s*:\s*['"`]var\(--color-ink-(?:faint|ghost)\)['"`]/g;
/** A Typography (`prose`) variable set to faint ink; borders and rules are not text. */
const FAINT_PROSE = /--tw-prose-(?:invert-)?([\w-]+)\s*:\s*var\(--color-ink-(?:faint|ghost)\)/g;
const NON_TEXT_PROSE = /(?:borders|hr)$/;

function faintProseCount(text: string): number {
  return [...text.matchAll(FAINT_PROSE)].filter((m) => !NON_TEXT_PROSE.test(m[1] ?? '')).length;
}

/** The literal text sizes under the floor in a class list or source. */
function smallLiterals(text: string): string[] {
  const classes = [...text.matchAll(LITERAL_SIZE)]
    .filter((m) => {
      const value = m[1] ?? m[2] ?? '';
      return !COLOR_VALUE.test(value) && isUndersized(value);
    })
    .map((m) => m[0]);
  // A bare number is React's px; a quoted value is any CSS size, keywords and calc() included.
  const inline = [...text.matchAll(INLINE_SIZE)]
    .filter((m) => isUndersized(m[1] ?? `${m[2] ?? ''}px`))
    .map((m) => m[0]);
  return [...classes, ...inline];
}

/**
 * Files allowed a fixed number of faint-text classes, each drawing decoration
 * only: a glyph, a separator, a grip, a disabled mark. The count is exact, so a
 * new faint use in a listed file fails as surely as one in an unlisted file,
 * and a stale allowance fails too.
 */
const DECORATION: Record<string, { count: number; why: string }> = {
  'components/authoring-sheet.tsx': {
    count: 2,
    why: 'the › after the home label and the ▾ picker chevron',
  },
  'components/browser-list.tsx': { count: 1, why: 'the search icon beside the input' },
  'components/crumbs.tsx': { count: 1, why: 'the › separators between crumbs' },
  'components/decisions-walkthrough/rail.tsx': {
    count: 1,
    why: 'the send glyph while Check and send is unreachable; its label reads',
  },
  'components/jump-palette.tsx': { count: 1, why: 'the row icon that repeats its label' },
  'components/patterns/feed/deck-pager.tsx': {
    count: 2,
    why: 'a pager arrow’s chevron at an end, which keeps that ink on hover; its name reads',
  },
  'components/patterns/record-header.tsx': {
    count: 1,
    why: 'the / separators between a record header’s ancestors',
  },
  'components/project-picker.tsx': {
    count: 2,
    why: 'the trigger chevron and the search icon beside the input',
  },
  'components/ui/command.tsx': { count: 1, why: 'the search icon beside the input' },
  'routes/artifact.tsx': { count: 1, why: 'the › separator between crumbs' },
  'routes/kit.tsx': { count: 2, why: 'the ink swatches name each token' },
  'routes/seed.tsx': { count: 1, why: 'the › separator between crumbs' },
  'routes/settings-notifications.tsx': {
    count: 3,
    why: 'the › chevron after a row action, and a row’s ••• while it is disabled, which keeps that ink on hover; its name reads',
  },
  'routes/settings.tsx': { count: 1, why: 'the › chevron on a settings link row' },
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'test' ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function scan(): { faint: Map<string, number>; small: string[] } {
  const faint = new Map<string, number>();
  const small: string[] = [];
  for (const path of sourceFiles(SRC)) {
    const file = relative(SRC, path);
    const text = readFileSync(path, 'utf8');
    const count =
      [...text.matchAll(FAINT_TEXT)].length +
      [...text.matchAll(INLINE_FAINT)].length +
      faintProseCount(text);
    if (count > 0) {
      faint.set(file, count);
    }
    small.push(...smallLiterals(text).map((literal) => `${file}: ${literal}`));
  }
  return { faint, small };
}

/**
 * styles.css's own rules: a `font-size` under the floor, an `@apply` with
 * faint text or an undersized size, and faint ink set as a text colour. Faint
 * ink on a non-text property (an edge, a scrollbar) passes.
 */
function stylesheetFindings(): string[] {
  const found: string[] = [];
  for (const match of STYLES.matchAll(/(?<![\w-])font-size\s*:\s*([^;}]+)/g)) {
    if (isUndersized(match[1] ?? '')) {
      found.push(match[0].trim());
    }
  }
  // The `font` shorthand: its size is the first length, before any `/line-height`.
  for (const match of STYLES.matchAll(/(?<![\w-])font\s*:\s*([^;}]+)/g)) {
    const size =
      /(?:^|\s)([\d.]+(?:px|rem|pt|em|%)|xx-small|x-small|smaller|small|calc\([^)]*\))(?:\/|\s|$)/.exec(
        match[1] ?? '',
      )?.[1];
    if (size !== undefined && isUndersized(size)) {
      found.push(match[0].trim());
    }
  }
  for (const match of STYLES.matchAll(/@apply\s+([^;}]+)/g)) {
    const classes = match[1] ?? '';
    if ([...classes.matchAll(FAINT_TEXT)].length > 0 || smallLiterals(classes).length > 0) {
      found.push(match[0].trim());
    }
  }
  for (const match of STYLES.matchAll(
    /(?<![\w-])([\w-]+)\s*:\s*[^;{}]*var\(--color-ink-(?:faint|ghost)\)/g,
  )) {
    if (match[1] === 'color') {
      found.push(match[0].trim());
    }
  }
  if (faintProseCount(STYLES) > 0) {
    found.push('a --tw-prose text variable set to faint ink');
  }
  return found;
}

describe('readable type (MMR-718)', () => {
  it('declares no type token under the 12px floor', () => {
    const tokens = typeTokens();
    expect(tokens.length).toBeGreaterThan(5);
    const under = tokens
      .filter(([, value]) => isUndersized(value))
      .map(([name, value]) => `--text-${name}: ${value}`);
    expect(under).toEqual([]);
  });

  it('sets no size under 12px, faint text, or faint text colour in styles.css rules', () => {
    expect(stylesheetFindings()).toEqual([]);
  });

  it('uses no literal text size under 12px', () => {
    expect(scan().small).toEqual([]);
  });

  it('draws faint text only where it is listed as decoration', () => {
    const { faint } = scan();
    const unexpected = [...faint]
      .filter(([file, count]) => count !== DECORATION[file]?.count)
      .map(([file, count]) => `${file}: ${count} (allowed ${DECORATION[file]?.count ?? 0})`);
    const stale = Object.keys(DECORATION).filter((file) => !faint.has(file));
    expect(unexpected).toEqual([]);
    expect(stale).toEqual([]);
  });
});

describe('the status word (MMR-718)', () => {
  it.each(STATUS_ORDER)('draws %s in bright ink and keeps the hue on its dot', (status) => {
    const { container } = render(<StatusBadge status={status} />);
    const word = screen.getByText(STATUS_META[status].label);
    expect(word).toHaveClass('text-ink-bright', 'font-semibold', 'text-meta');
    // No status hue on the word or anything around it but the dot.
    const hued = [...container.querySelectorAll('*')].filter((el) =>
      [...el.classList].some((c) => c.includes('status-')),
    );
    expect(hued).toHaveLength(1);
    expect(hued[0]).toHaveAttribute('aria-hidden');
    expect(hued[0]).toHaveClass(STATUS_META[status].dot);
  });

  it('reads a standing in place of the label, in the same bright word', () => {
    render(<StatusBadge status="done" label="Done 2026-11-21" />);
    expect(screen.getByText('Done 2026-11-21')).toHaveClass('text-ink-bright', 'font-semibold');
    expect(screen.queryByText('Done')).toBeNull();
  });

  it('draws a word beside a status (a seed lane) the same way', () => {
    render(<StatusWord>Ready to resolve</StatusWord>);
    const word = screen.getByText('Ready to resolve');
    expect(word).toHaveClass('text-ink-bright', 'font-semibold', 'text-meta');
    expect(word.className).not.toMatch(/status-/);
  });
});
