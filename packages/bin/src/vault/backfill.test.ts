import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NornClient } from '../core/store-norn/client';
import type { NornSetArgs } from '../core/store-norn/client';
import { bunExec } from '../exec';
import { backfillProjectField, backfillVaultData } from './backfill';
import { converge } from './converge';
import { MARKER_FILE, NORN_CONFIG_FILE, renderNornConfig, VAULT_SCHEMA } from './schema';

// ── Unit: the field derivation + write shape (fake client) ───────────────────

test('backfillProjectField sets project from the STEM, addressed by stem, confirmed', async () => {
  const sets: NornSetArgs[] = [];
  const client = {
    find: () =>
      Promise.resolve([
        { path: 'MMR/MMR.md' }, // project doc — self-referential
        { path: 'MMR/MMR-3.md' }, // node under MMR
        { path: 'OTH/OTH-1.md' }, // node under OTH — key from the stem, not any shared dir
      ]),
    set: (args: NornSetArgs) => {
      sets.push(args);
      return Promise.resolve({ report: { applied: true } });
    },
  } as unknown as NornClient;

  const changed = await backfillProjectField(client);

  // Each write targets the bare STEM (never the KEY/… path) and confirms.
  expect(sets).toEqual([
    { confirm: true, set: { project: '[[MMR]]' }, target: 'MMR' },
    { confirm: true, set: { project: '[[MMR]]' }, target: 'MMR-3' },
    { confirm: true, set: { project: '[[OTH]]' }, target: 'OTH-1' },
  ]);
  // The changed set is reported as paths (converge stages files).
  expect(changed).toEqual(['MMR/MMR.md', 'MMR/MMR-3.md', 'OTH/OTH-1.md']);
});

test('backfillProjectField skips a document whose stem does not parse to an identity', async () => {
  const sets: NornSetArgs[] = [];
  const client = {
    find: () => Promise.resolve([{ path: 'x/notes.md' }]),
    set: (args: NornSetArgs) => {
      sets.push(args);
      return Promise.resolve({});
    },
  } as unknown as NornClient;

  expect(await backfillProjectField(client)).toEqual([]);
  expect(sets).toEqual([]);
});

test('backfillVaultData is a no-op (no client) once the vault is at the project-field schema', async () => {
  // fromSchema >= 3 short-circuits before touching Norn; an unusable path proves
  // no client was spawned.
  expect(await backfillVaultData('/nonexistent/vault', 3)).toEqual([]);
});

// ── Integration: converge upgrades a schema-2 vault and backfills (real norn) ──

const NORN = Bun.which('norn') !== null;
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mimir-backfill-'));
});
afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

test.skipIf(!NORN)(
  'converge backfills project onto a schema-2 vault, then the docs are findable',
  async () => {
    const vault = join(root, 'v');
    mkdirSync(join(vault, '.norn'), { recursive: true });
    mkdirSync(join(vault, 'MMR'), { recursive: true });
    // A schema-2 vault: current rules on disk, marker at 2, docs with no project.
    writeFileSync(join(vault, NORN_CONFIG_FILE), renderNornConfig());
    writeFileSync(join(vault, MARKER_FILE), 'schema = 2\n');
    writeFileSync(
      join(vault, 'MMR', 'MMR.md'),
      '---\nkey: MMR\nname: n\ntype: project\ncreated: 2026-01-01T00:00:00Z\nupdated_at: 2026-01-01T00:00:00Z\n---\nx\n',
    );
    writeFileSync(
      join(vault, 'MMR', 'MMR-1.md'),
      '---\ntitle: t\ntype: task\ncreated: 2026-01-01T00:00:00Z\nupdated_at: 2026-01-01T00:00:00Z\n---\nx\n',
    );

    const result = await converge(vault, {
      allowCreate: false,
      exec: bunExec,
      migrateData: backfillVaultData,
    });
    expect(result.outcome === 'converged' && result.upgraded).toBe(true);

    // Both documents now carry the self-referential / owning-project wikilink…
    expect(readFileSync(join(vault, 'MMR', 'MMR.md'), 'utf8')).toContain('project:');
    expect(readFileSync(join(vault, 'MMR', 'MMR-1.md'), 'utf8')).toContain('project:');
    // …the marker advanced only after the backfill (crash-safe ordering), to
    // whatever schema this binary produces — derived, so a later bump doesn't
    // break this (converge.test.ts derives the same way)…
    expect(readFileSync(join(vault, MARKER_FILE), 'utf8')).toContain(
      `schema = ${String(VAULT_SCHEMA)}`,
    );

    // …and the whole point: they are now scopable by the declared field.
    const client = new NornClient({ vaultPath: vault });
    try {
      const found = await client.find({
        eq: ['project:MMR'],
        in: ['type:project,task,phase,initiative'],
        no_limit: true,
      });
      expect(found.map((d) => d.path).toSorted()).toEqual(['MMR/MMR-1.md', 'MMR/MMR.md']);
    } finally {
      await client.close();
    }
  },
);
