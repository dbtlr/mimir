import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeIo } from '../cli/testing';
import { createInitiative, createProject, createTask } from '../core/create';
import type { ImportOptions, ImportReport, StoreExport } from '../core/export';
import type { Store } from '../core/store';
import type { PostgresTestStore } from '../core/store-postgres/testing';
import { createPgliteTestStore } from '../core/store-postgres/testing';
import type { GlobalConfig } from '../service/config';
import type { StoreDeps } from './commands';
import { cmdStore } from './commands';

/**
 * `store export` and `store import` (MMR-380) — the operator face of the seam's
 * transfer document (ADR 0030 Decision 4). The command layer owns the file, the
 * flags, and the report; the document itself and every refusal inside it are the
 * backend's, tested there.
 *
 * Two fixtures, deliberately: a real PGlite-backed `Store` where the document
 * has to survive a round trip, and a recording fake where the only fact under
 * test is which {@link ImportOptions} the flags produced.
 */

/** The store machinery deps — never reached by a transfer verb, which routes
 * through `getStore` like every other data verb. */
const DEPS: StoreDeps = {
  openPostgres: () => {
    throw new Error('a transfer verb must not open the store machinery connection');
  },
  readConfig: (): GlobalConfig => ({ serve: {}, store: {}, vault: {} }),
};

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mimir-store-transfer-'));
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

/** A PGlite store holding one project, one initiative, and one task. */
async function seeded(): Promise<PostgresTestStore> {
  const pg = await createPgliteTestStore();
  const project = await createProject(pg.store, { key: 'MMR', name: 'Mimir' });
  const initiative = await createInitiative(pg.store, {
    projectId: project.key,
    title: 'Shared store',
  });
  await createTask(pg.store, { parentId: initiative.id, title: 'Export and import' });
  return pg;
}

/** A `Store` that records the import it was asked for and answers a fixed report. */
function recordingStore(report: ImportReport): { store: Store; calls: ImportOptions[] } {
  const calls: ImportOptions[] = [];
  const store = {
    import: (_document: StoreExport, opts: ImportOptions) => {
      calls.push(opts);
      return Promise.resolve(report);
    },
  } as unknown as Store;
  return { calls, store };
}

/** The minimal document the shape check accepts — the backend validates the rest. */
const MINIMAL: Pick<StoreExport, 'schema_version'> = { schema_version: 1 };

async function message(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

test('store export writes the document to a file and reports its counts', async () => {
  const io = fakeIo();
  const pg = await seeded();
  const file = join(dir, 'vault.json');
  try {
    expect(await cmdStore(['store', 'export', file], {}, io, DEPS, 'records', () => pg.store)).toBe(
      0,
    );
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, 'utf8');
    // Pretty-printed with a trailing newline: this is a backup a human diffs.
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "schema_version"');
    const document = JSON.parse(text) as StoreExport;
    expect(document.schema_version).toBe(1);
    expect(document.projects).toHaveLength(1);
    expect(document.nodes).toHaveLength(2);
    expect(io.out.join('\n')).toContain('store: exported 1 project, 2 nodes, 0 artifacts');
    expect(io.out.join('\n')).toContain(file);
    expect(io.err).toEqual([]);
  } finally {
    await pg.close();
  }
});

test('store export in json format emits a machine-readable report', async () => {
  const io = fakeIo();
  const pg = await seeded();
  const file = join(dir, 'vault.json');
  try {
    expect(await cmdStore(['store', 'export', file], {}, io, DEPS, 'json', () => pg.store)).toBe(0);
    const report = JSON.parse(io.out.join('')) as Record<string, unknown>;
    expect(report).toMatchObject({ nodes: 2, path: file, projects: 1, schema_version: 1 });
  } finally {
    await pg.close();
  }
});

test('store export to - writes the document and nothing else to stdout', async () => {
  const io = fakeIo();
  const pg = await seeded();
  try {
    expect(await cmdStore(['store', 'export', '-'], {}, io, DEPS, 'records', () => pg.store)).toBe(
      0,
    );
    const document = JSON.parse(io.out.join('\n')) as StoreExport;
    expect(document.projects).toHaveLength(1);
    expect(io.err).toEqual([]);
  } finally {
    await pg.close();
  }
});

test('store export refuses to overwrite an existing file', async () => {
  const pg = await seeded();
  const file = join(dir, 'vault.json');
  writeFileSync(file, 'an earlier backup');
  try {
    const text = await message(
      cmdStore(['store', 'export', file], {}, fakeIo(), DEPS, 'records', () => pg.store),
    );
    expect(text).toContain(file);
    expect(text).toContain('already exists');
    // The earlier backup is untouched.
    expect(readFileSync(file, 'utf8')).toBe('an earlier backup');
  } finally {
    await pg.close();
  }
});

test('store export requires exactly one file argument', async () => {
  const pg = await seeded();
  try {
    expect(
      await message(cmdStore(['store', 'export'], {}, fakeIo(), DEPS, 'records', () => pg.store)),
    ).toBe('store export requires a file (or - for stdout)');
    expect(
      await message(
        cmdStore(
          ['store', 'export', 'a.json', 'b.json'],
          {},
          fakeIo(),
          DEPS,
          'records',
          () => pg.store,
        ),
      ),
    ).toBe('store export takes exactly one file');
  } finally {
    await pg.close();
  }
});

test('store import previews by default and says how to write', async () => {
  const io = fakeIo();
  const file = join(dir, 'vault.json');
  writeFileSync(file, JSON.stringify(MINIMAL));
  const fake = recordingStore({ applied: false, created: 3, mode: 'fresh', skipped: 0 });

  expect(await cmdStore(['store', 'import', file], {}, io, DEPS, 'records', () => fake.store)).toBe(
    0,
  );
  expect(fake.calls).toEqual([{ dryRun: true, mode: 'fresh' }]);
  const line = io.out.join('\n');
  expect(line).toContain('import preview');
  expect(line).toContain('would create 3, skip 0 (fresh)');
  expect(line).toContain('--apply');
});

test('store import --apply --resume writes in resume mode', async () => {
  const io = fakeIo();
  const file = join(dir, 'vault.json');
  writeFileSync(file, JSON.stringify(MINIMAL));
  const fake = recordingStore({ applied: true, created: 2, mode: 'resume', skipped: 1 });

  expect(
    await cmdStore(
      ['store', 'import', file],
      { apply: true, resume: true },
      io,
      DEPS,
      'records',
      () => fake.store,
    ),
  ).toBe(0);
  expect(fake.calls).toEqual([{ dryRun: false, mode: 'resume' }]);
  expect(io.out.join('\n')).toContain('store: imported 2, skipped 1 (resume)');
});

test('store import in json format emits the import report', async () => {
  const io = fakeIo();
  const file = join(dir, 'vault.json');
  writeFileSync(file, JSON.stringify(MINIMAL));
  const fake = recordingStore({ applied: false, created: 3, mode: 'fresh', skipped: 0 });

  expect(await cmdStore(['store', 'import', file], {}, io, DEPS, 'json', () => fake.store)).toBe(0);
  expect(JSON.parse(io.out.join(''))).toEqual({
    applied: false,
    created: 3,
    mode: 'fresh',
    skipped: 0,
  });
});

test('store import refuses a file that is not a transfer document, naming it', async () => {
  const fake = recordingStore({ applied: true, created: 0, mode: 'fresh', skipped: 0 });

  const missing = join(dir, 'absent.json');
  const gone = await message(
    cmdStore(['store', 'import', missing], {}, fakeIo(), DEPS, 'records', () => fake.store),
  );
  expect(gone).toContain(missing);

  const garbage = join(dir, 'garbage.json');
  writeFileSync(garbage, 'not json at all');
  const unparsed = await message(
    cmdStore(['store', 'import', garbage], {}, fakeIo(), DEPS, 'records', () => fake.store),
  );
  expect(unparsed).toContain(garbage);
  expect(unparsed).toContain('valid JSON');

  const wrong = join(dir, 'wrong.json');
  writeFileSync(wrong, JSON.stringify({ hello: 'world' }));
  const shapeless = await message(
    cmdStore(['store', 'import', wrong], {}, fakeIo(), DEPS, 'records', () => fake.store),
  );
  expect(shapeless).toContain(wrong);
  expect(shapeless).toContain('schema_version');

  // Nothing reached the store on any of the three.
  expect(fake.calls).toEqual([]);
});

test('store import requires a file argument', async () => {
  const fake = recordingStore({ applied: true, created: 0, mode: 'fresh', skipped: 0 });
  expect(
    await message(cmdStore(['store', 'import'], {}, fakeIo(), DEPS, 'records', () => fake.store)),
  ).toBe('store import requires a file (or - for stdin)');
});

test('export, import --apply, and re-export round trip to the same document', async () => {
  const source = await seeded();
  const target = await createPgliteTestStore();
  const first = join(dir, 'first.json');
  const second = join(dir, 'second.json');
  try {
    expect(
      await cmdStore(['store', 'export', first], {}, fakeIo(), DEPS, 'records', () => source.store),
    ).toBe(0);
    expect(
      await cmdStore(
        ['store', 'import', first],
        { apply: true },
        fakeIo(),
        DEPS,
        'records',
        () => target.store,
      ),
    ).toBe(0);
    expect(
      await cmdStore(
        ['store', 'export', second],
        {},
        fakeIo(),
        DEPS,
        'records',
        () => target.store,
      ),
    ).toBe(0);

    const before = JSON.parse(readFileSync(first, 'utf8')) as StoreExport;
    const after = JSON.parse(readFileSync(second, 'utf8')) as StoreExport;
    // `exported_at` is the one field a re-export may differ in (ADR 0030).
    expect({ ...after, exported_at: '' }).toEqual({ ...before, exported_at: '' });
  } finally {
    await source.close();
    await target.close();
  }
});
