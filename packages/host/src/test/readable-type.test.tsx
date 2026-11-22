// Reads the console's sources to check their class lists.
// oxlint-disable-next-line import/no-nodejs-modules
import { readdirSync, readFileSync } from 'node:fs';
// oxlint-disable-next-line import/no-nodejs-modules
import { join, relative } from 'node:path';

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StatusBadge } from '../components/status-badge';
import { STATUS_META, STATUS_ORDER } from '../lib/status';

/**
 * Readable type (ADR 0019, MMR-718): nothing that carries information is under
 * 12px, and information text is `ink-dim` or brighter. The token cases read
 * styles.css; the source scan reads every console source file, so a faint or
 * undersized class that returns fails here before it ships.
 */
/** The console's sources, from the package root the tests run in. */
const SRC = 'src';
const STYLES = readFileSync(join(SRC, 'styles.css'), 'utf8');

/** The `--text-<step>` sizes declared in the theme, in px (line heights excluded). */
function typeTokens(): Map<string, number> {
  const tokens = new Map<string, number>();
  for (const match of STYLES.matchAll(/--text-([a-z-]+?):\s*([\d.]+)rem/g)) {
    tokens.set(match[1] as string, Number(match[2]) * 16);
  }
  return tokens;
}

/**
 * Faint text and literal sizes under the floor. A variant prefix
 * (`placeholder:`, `hover:`, `md:`) still counts: what it styles is text.
 */
const FAINT_TEXT = /(?<![\w-])(?:[\w-]+:)*text-ink-(?:faint|ghost)(?![\w-])/g;
const LITERAL_SIZE = /(?<![\w-])(?:[\w-]+:)*text-\[([\d.]+)(px|rem)\]/g;

/**
 * Files allowed a fixed number of faint-text classes, each drawing decoration
 * only: a glyph, a separator, a grip, a disabled mark. The count is exact, so a
 * new faint use in a listed file fails as surely as one in an unlisted file,
 * and a stale allowance fails too.
 */
const DECORATION: Record<string, { count: number; why: string }> = {
  'components/authoring-sheet.tsx': {
    count: 4,
    why: 'the › after the home label, the ▾ picker chevron, and the disclosure chevrons',
  },
  'components/browser-list.tsx': { count: 1, why: 'the search icon beside the input' },
  'components/crumbs.tsx': { count: 1, why: 'the › separators between crumbs' },
  'components/decisions-walkthrough/rail.tsx': {
    count: 1,
    why: 'the send glyph while Check and send is unreachable; its label reads',
  },
  'components/jump-palette.tsx': { count: 1, why: 'the row icon that repeats its label' },
  'components/project-picker.tsx': {
    count: 2,
    why: 'the trigger chevron and the search icon beside the input',
  },
  'components/ui/collapsible.tsx': { count: 1, why: 'the chevron beside the trigger label' },
  'components/ui/command.tsx': { count: 1, why: 'the search icon beside the input' },
  'routes/artifact.tsx': { count: 1, why: 'the › separator between crumbs' },
  'routes/kit.tsx': { count: 2, why: 'the ink swatches name each token' },
  'routes/seed.tsx': { count: 1, why: 'the › separator between crumbs' },
  'routes/settings-notifications.tsx': { count: 1, why: 'the › chevron after a row action' },
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
    const count = [...text.matchAll(FAINT_TEXT)].length;
    if (count > 0) {
      faint.set(file, count);
    }
    for (const match of text.matchAll(LITERAL_SIZE)) {
      const px = Number(match[1]) * (match[2] === 'rem' ? 16 : 1);
      if (px < 12) {
        small.push(`${file}: ${match[0]}`);
      }
    }
  }
  return { faint, small };
}

describe('readable type (MMR-718)', () => {
  it('declares no type token under the 12px floor', () => {
    const tokens = typeTokens();
    expect(tokens.size).toBeGreaterThan(5);
    const under = [...tokens].filter(([, px]) => px < 12).map(([name, px]) => `${name} ${px}px`);
    expect(under).toEqual([]);
  });

  it('sets feed titles at 16px and lone IDs at 12.5px', () => {
    const tokens = typeTokens();
    expect(tokens.get('title')).toBe(16);
    expect(tokens.get('mono-id')).toBe(12.5);
    expect(tokens.has('card-mobile')).toBe(false);
  });

  it('tracks the microlabel at 0.1em', () => {
    const rule = /\.microlabel\s*\{[^}]*\}/.exec(STYLES)?.[0] ?? '';
    expect(rule).toContain('text-micro');
    expect(rule).toContain('tracking-[0.1em]');
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
});
