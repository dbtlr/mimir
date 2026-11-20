import { afterEach, beforeEach, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The committed UI SDK skill (`skills/ui-sdk/`) is a copy of the one
 * `@ui-sdk/core` ships at the pinned version (ADR 0046), so agents read
 * guidance matched to the installed code. An upgrade that leaves the copy
 * behind fails here; refresh it with
 * `cp -R packages/host/node_modules/@ui-sdk/core/skills/ui-sdk skills/`.
 */
const COMMITTED = fileURLToPath(new URL('../../../skills/ui-sdk', import.meta.url));
const INSTALLED = fileURLToPath(
  new URL('../node_modules/@ui-sdk/core/skills/ui-sdk', import.meta.url),
);

/** Every file under `dir`, relative, with its text, in path order. */
function tree(dir: string, prefix = ''): [string, string][] {
  const entries = readdirSync(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries.flatMap((entry): [string, string][] =>
    entry.isDirectory()
      ? tree(join(dir, entry.name), `${prefix}${entry.name}/`)
      : [[`${prefix}${entry.name}`, readFileSync(join(dir, entry.name), 'utf8')]],
  );
}

/** The relative paths that differ between two skill folders: changed, added, or missing. */
function drift(committed: string, installed: string): string[] {
  const ours = new Map(tree(committed));
  const theirs = new Map(tree(installed));
  const paths = new Set([...ours.keys(), ...theirs.keys()]);
  const drifted = [...paths].filter((path) => ours.get(path) !== theirs.get(path));
  drifted.sort();
  return drifted;
}

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'mimir-ui-sdk-skill-'));
});
afterEach(() => {
  rmSync(scratch, { force: true, recursive: true });
});

test('the committed skill matches the installed package copy', () => {
  expect(drift(COMMITTED, INSTALLED)).toEqual([]);
});

test('a changed file in the committed copy is reported', () => {
  cpSync(COMMITTED, scratch, { recursive: true });
  writeFileSync(
    join(scratch, 'SKILL.md'),
    `${readFileSync(join(scratch, 'SKILL.md'), 'utf8')}\nedited\n`,
  );
  expect(drift(scratch, INSTALLED)).toEqual(['SKILL.md']);
});

test('a file added to or missing from the committed copy is reported', () => {
  cpSync(COMMITTED, scratch, { recursive: true });
  writeFileSync(join(scratch, 'extra.md'), 'not upstream\n');
  rmSync(join(scratch, 'references', 'testing.md'));
  expect(drift(scratch, INSTALLED)).toEqual(['extra.md', 'references/testing.md']);
});
