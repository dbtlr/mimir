/**
 * Changelog compiler — assemble the pending `.changes/*.md` fragments into a
 * `## vX.Y.Z - YYYY-MM-DD` release section (ADR 0022).
 *
 * Preview (what would the next release section say?):
 *   bun run changelog:compile
 *
 * Cut (write the section into CHANGELOG.md and delete the compiled fragments —
 * the release-cut procedure's promote step):
 *   bun run changelog:compile --write --version X.Y.Z
 *
 * Check (parse fragments and report violations — what changelog-guard runs, so
 * the guard and the cut share one grammar):
 *   bun run changelog:compile --check [files...]   (default: all pending)
 *
 * Fragments use the Keep-a-Changelog grammar verbatim: H3 category headings
 * from the closed set, `- ` bullets beneath them, nothing else. The compiler
 * concatenates — it never rewrites prose. Categories render in canonical
 * Keep-a-Changelog order; within a category, fragments keep landing order
 * (the commit date each file was added; filename as tie-break).
 *
 * Run from the repo root (`bun run changelog:compile` does).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isMember, parseJson } from '@mimir/helpers';

export const CATEGORIES = [
  'Added',
  'Changed',
  'Deprecated',
  'Removed',
  'Fixed',
  'Security',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** One fragment's entries: category → bullet blocks (verbatim, multi-line). */
export type FragmentSections = Partial<Record<Category, string[]>>;

const fail = (file: string, line: number, message: string): never => {
  throw new Error(`${file}:${line}: ${message}`);
};

/**
 * Parse one fragment. Strict by design — the same violations the
 * changelog-guard shape check rejects at PR time are errors here, so a
 * malformed fragment can never survive to the cut.
 */
export const parseFragment = (file: string, text: string): FragmentSections => {
  const sections: FragmentSections = {};
  let current: Category | null = null;
  let block: string[] = [];

  const flush = () => {
    if (current === null || block.length === 0) {
      return;
    }
    while (block.length > 0 && block[block.length - 1]?.trim() === '') {
      block.pop();
    }
    (sections[current] ??= []).push(block.join('\n'));
    block = [];
  };

  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    const at = index + 1;
    const h3 = /^### (.*)$/.exec(line);
    if (h3) {
      const heading = (h3[1] ?? '').trim();
      if (!isMember(heading, CATEGORIES)) {
        fail(file, at, `unknown category "${heading}" — expected one of: ${CATEGORIES.join(', ')}`);
      } else {
        flush();
        current = heading;
      }
      continue;
    }
    if (line.startsWith('#')) {
      fail(file, at, 'only H3 category headings are allowed in a fragment');
    }
    if (/^[-*] /.test(line)) {
      if (current === null) {
        fail(file, at, 'bullet outside a category heading');
      }
      flush();
      block.push(line);
      continue;
    }
    if (line.trim() === '') {
      if (block.length > 0) {
        block.push(line);
      }
      continue;
    }
    if (/^\s/.test(line)) {
      if (block.length === 0) {
        fail(file, at, 'continuation line outside a bullet');
      }
      block.push(line);
      continue;
    }
    fail(file, at, 'prose outside a bullet — entries are bullets under a category heading');
  }
  flush();

  if (Object.values(sections).every((blocks) => blocks.length === 0)) {
    fail(file, 1, 'fragment has no entries');
  }
  return sections;
};

/** Render the release section from parsed fragments, order-preserving. */
export const renderSection = (
  version: string,
  date: string,
  fragments: FragmentSections[],
): string => {
  const parts = [`## v${version} - ${date}`];
  for (const category of CATEGORIES) {
    const blocks = fragments.flatMap((sections) => sections[category] ?? []);
    if (blocks.length === 0) {
      continue;
    }
    parts.push(`### ${category}`, blocks.join('\n'));
  }
  return `${parts.join('\n\n')}\n`;
};

/** Insert the section above the first existing release heading. */
export const insertSection = (changelog: string, section: string): string => {
  const lines = changelog.split('\n');
  const first = lines.findIndex((line) => line.startsWith('## '));
  if (first === -1) {
    return `${changelog.trimEnd()}\n\n${section}`;
  }
  return [...lines.slice(0, first), section, ...lines.slice(first)].join('\n');
};

const CHANGES_DIR = '.changes';

const pendingFragments = (): string[] =>
  readdirSync(CHANGES_DIR)
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .sort();

/** Landing order: epoch seconds of the commit that added the file (uncommitted → last). */
const addedAt = (name: string): number => {
  const out = execFileSync(
    'git',
    ['log', '--diff-filter=A', '--format=%ct', '--', join(CHANGES_DIR, name)],
    {
      encoding: 'utf8',
    },
  ).trim();
  const oldest = out.split('\n').findLast((stamp) => stamp.length > 0);
  return oldest === undefined ? Number.MAX_SAFE_INTEGER : Number(oldest);
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const versionFlag = args.indexOf('--version');
  const version = versionFlag === -1 ? null : (args[versionFlag + 1] ?? null);

  const checkFlag = args.indexOf('--check');
  if (checkFlag !== -1) {
    const named = args.slice(checkFlag + 1).filter((arg) => !arg.startsWith('--'));
    if (named.length === 0 && !existsSync(CHANGES_DIR)) {
      console.error(`${CHANGES_DIR}/ not found — run from the repo root.`);
      process.exit(1);
    }
    const files =
      named.length > 0 ? named : pendingFragments().map((name) => join(CHANGES_DIR, name));
    let failed = false;
    for (const file of files) {
      try {
        parseFragment(file, readFileSync(file, 'utf8'));
      } catch (error) {
        failed = true;
        console.error(error instanceof Error ? error.message : String(error));
      }
    }
    if (failed) {
      process.exit(1);
    }
    console.log(`ok: ${files.length} fragment(s) parse`);
    process.exit(0);
  }

  if (!existsSync(CHANGES_DIR)) {
    console.error(`${CHANGES_DIR}/ not found — run from the repo root.`);
    process.exit(1);
  }

  const names = pendingFragments();
  if (names.length === 0) {
    if (write) {
      console.error('No pending fragments — nothing to ship.');
      process.exit(1);
    }
    console.log('No pending fragments.');
    process.exit(0);
  }

  const ordered = names
    .map((name) => ({ added: addedAt(name), name }))
    .toSorted((a, b) => a.added - b.added || a.name.localeCompare(b.name));
  const fragments = ordered.map(({ name }) =>
    parseFragment(join(CHANGES_DIR, name), readFileSync(join(CHANGES_DIR, name), 'utf8')),
  );

  if (write) {
    if (version === null || !/^\d+\.\d+\.\d+$/.test(version)) {
      console.error('--write requires --version X.Y.Z (the release being cut).');
      process.exit(1);
    }
    const date = new Date().toISOString().slice(0, 10);
    const section = renderSection(version, date, fragments);
    writeFileSync('CHANGELOG.md', insertSection(readFileSync('CHANGELOG.md', 'utf8'), section));
    for (const { name } of ordered) {
      rmSync(join(CHANGES_DIR, name));
    }
    console.log(
      `Wrote ## v${version} - ${date} (${ordered.length} fragment${ordered.length === 1 ? '' : 's'} compiled and deleted).`,
    );
  } else {
    // Preview under the next target version (the -next base) and today's date.
    const pkg = parseJson<{ version: string }>(readFileSync('packages/bin/package.json', 'utf8'));
    const base = pkg.version.replace(/-next.*$/, '');
    console.log(renderSection(base, new Date().toISOString().slice(0, 10), fragments));
  }
}
