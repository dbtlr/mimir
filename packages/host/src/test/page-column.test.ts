// Reads the console's sources to check the widths their pages centre on.
// oxlint-disable-next-line import/no-nodejs-modules
import { readdirSync, readFileSync } from 'node:fs';
// oxlint-disable-next-line import/no-nodejs-modules
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/*
 * A page is one centred column, 900 wide at most (ADR 0013, MMR-729
 * refinement; DESIGN.md, Page column). A page centres on PAGE_COLUMN or a
 * narrower width of its own, never a wider one. The rail grid of the seed,
 * artifact, and delivery pages stands until MMR-732; the task page left it
 * with MMR-728.
 */

const SRC = 'src';

/** The widths allowed past 900, by file: the rail grid in RecordLayout. */
const RAIL_GRID = { file: 'src/components/record-layout.tsx', width: 1200 };

/** The console's page sources: tests and the dev-only `/kit` aside. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'test' || entry.name === 'kit' ? [] : sources(path);
    }
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Each centred width in a file: a `max-w-[Npx]` in a class list that also centres with `mx-auto`. */
function centredWidths(text: string): number[] {
  return [...text.matchAll(/'[^'\n]*'|"[^"\n]*"/g)]
    .map(([list]) => list)
    .filter((list) => /\bmx-auto\b/.test(list))
    .flatMap((list) => [...list.matchAll(/max-w-\[(\d+)px\]/g)].map(([, width]) => Number(width)));
}

describe('page column (MMR-729)', () => {
  it('centres every page on 900 at most, the rail grid aside', () => {
    const wide = sources(SRC).flatMap((path) => {
      const file = relative('.', path);
      return centredWidths(readFileSync(path, 'utf8'))
        .filter((width) => width > 900)
        .filter((width) => !(file === RAIL_GRID.file && width === RAIL_GRID.width))
        .map((width) => `${file}: ${String(width)}`);
    });
    expect(wide).toEqual([]);
  });

  it('finds the widths it checks', () => {
    expect(centredWidths(`<main className="mx-auto w-full max-w-[1200px] p-5">`)).toEqual([1200]);
    expect(centredWidths(`'mx-auto w-full max-w-[900px]'`)).toEqual([900]);
  });
});
