// Reads the console's sources to check their class lists.
// oxlint-disable-next-line import/no-nodejs-modules
import { readdirSync, readFileSync } from 'node:fs';
// oxlint-disable-next-line import/no-nodejs-modules
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/*
 * Tailwind 4's `outline-none` sets the outline style to none, and
 * `focus-visible:outline-N` sets only the width, so a control that pairs them
 * draws no focus outline (DESIGN.md, Controls: focus). Every such class list
 * also sets `focus-visible:outline-solid`.
 */

/** The console's sources, from the package root the tests run in. */
const SRC = 'src';

/** The console's source files, tests aside. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'test' ? [] : sources(path);
    }
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const LITERAL = /'[^'\n]*'|"[^"\n]*"|`[^`]*`/g;

/** The class lists in a file: each string literal, joined with the literals beside it in one call. */
function classLists(text: string): string[] {
  const lists: string[] = [];
  let end = -1;
  for (const match of text.matchAll(LITERAL)) {
    const between = end === -1 ? '' : text.slice(end, match.index);
    if (end !== -1 && /^\s*,\s*$/.test(between)) {
      lists[lists.length - 1] += ` ${match[0]}`;
    } else {
      lists.push(match[0]);
    }
    end = match.index + match[0].length;
  }
  return lists;
}

/** Whether a class list hides the outline and then draws a focus outline only by its width. */
function hidesItsFocusRing(list: string): boolean {
  return (
    /(^|[\s'"`])outline-(none|hidden)\b/.test(list) &&
    /focus-visible:outline-\d/.test(list) &&
    !/focus-visible:outline-solid\b/.test(list)
  );
}

describe('focus rings', () => {
  it('every class list that hides the outline draws its focus outline solid', () => {
    const offenders = sources(SRC).flatMap((file) =>
      classLists(readFileSync(file, 'utf8'))
        .filter(hidesItsFocusRing)
        .map((list) => `${relative(SRC, file)}: ${list.slice(0, 80)}`),
    );
    expect(offenders).toEqual([]);
  });

  it('reads a class list split across a call’s arguments as one', () => {
    expect(
      classLists(`cn('rounded outline-none', 'focus-visible:outline-2')`).filter(hidesItsFocusRing),
    ).toHaveLength(1);
  });
});
