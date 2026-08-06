import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NornClient } from '../core/store-norn/client';
import type { NornSetArgs } from '../core/store-norn/client';
import { bunExec } from '../exec';
import {
  backfillCanonicalTimestamps,
  backfillJournalTimestamps,
  backfillProjectField,
  backfillVaultData,
} from './backfill';
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

test('backfillVaultData is a no-op (no client) once the vault is at the current schema', async () => {
  // The short-circuit tracks the LATEST migration's schema (MMR-351 moved it from
  // 3 to 9): a schema-3 vault still needs the timestamp pass, so only a vault at
  // the current schema skips Norn entirely — an unusable path proves no client
  // was spawned.
  expect(await backfillVaultData('/nonexistent/vault', VAULT_SCHEMA)).toEqual([]);
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

// ── MMR-351: the canonical-timestamp backfill ────────────────────────────────

test.skipIf(!NORN)(
  'converge normalizes zoned timestamp variants on a schema-8 vault and leaves the rest for doctor',
  async () => {
    const vault = join(root, 'v');
    mkdirSync(join(vault, '.norn'), { recursive: true });
    mkdirSync(join(vault, 'MMR', 'artifacts'), { recursive: true });
    mkdirSync(join(vault, 'MMR', 'seeds'), { recursive: true });
    writeFileSync(join(vault, NORN_CONFIG_FILE), renderNornConfig());
    writeFileSync(join(vault, MARKER_FILE), 'schema = 8\n');
    // A project whose stamps are an offset form and a millisecond-less Z form —
    // both state their instant, so both normalize…
    writeFileSync(
      join(vault, 'MMR', 'MMR.md'),
      "---\nkey: MMR\nname: n\nproject: '[[MMR]]'\ntype: project\ncreated: 2026-01-01T05:30:00+05:30\nupdated_at: 2026-01-01T00:00:00Z\n---\nx\n",
    );
    // …a task carrying a ZONE-LESS completed_at, which states none, so it must
    // survive the upgrade byte-for-byte rather than being guessed at…
    writeFileSync(
      join(vault, 'MMR', 'MMR-1.md'),
      "---\ntitle: t\nparent: '[[MMR]]'\nproject: '[[MMR]]'\ntype: task\ncreated: 2026-01-01T00:00:00.000Z\nupdated_at: 2026-01-01T00:00:00.000Z\ncompleted_at: 2026-01-02T09:00:00\n---\nx\n",
    );
    // …and an artifact + a seed, to prove the scan is not work-state-only.
    writeFileSync(
      join(vault, 'MMR', 'artifacts', 'MMR-a1.md'),
      "---\ntitle: t\nproject: '[[MMR]]'\ntype: artifact\ncreated: 2026-01-01T00:00:00-04:00\nupdated_at: 2026-01-01T00:00:00.000Z\n---\nx\n",
    );
    writeFileSync(
      join(vault, 'MMR', 'seeds', 'MMR-s1.md'),
      "---\ntitle: t\nproject: '[[MMR]]'\nkind: feature\nlifecycle: sown\ntype: seed\ncreated: 2026-01-01T00:00:00Z\nupdated_at: 2026-01-01T00:00:00.000Z\n---\nx\n",
    );

    // …and a Scratchpad, whose stamps live in the same invariant (ADR 0027 pads
    // are project-anchored documents, so the migration must reach them too).
    mkdirSync(join(vault, 'scratch'), { recursive: true });
    writeFileSync(
      join(vault, 'scratch', '018f3f36-7b2b-4c92-8f31-44c764a1a456.md'),
      "---\ntitle: Working notes\nproject: '[[MMR]]'\ntype: scratch\n" +
        'created: 2026-01-01T05:30:00+05:30\nupdated_at: 2026-01-01T00:00:00.000Z\n' +
        'freezing_at: 2026-01-02T00:00:00\n---\n## Journal\n\n' +
        '### 1 — 2026-01-01T05:30:00+05:30\n\ncheckpoint\n\n## Agenda\n',
    );

    const result = await converge(vault, {
      allowCreate: false,
      exec: bunExec,
      migrateData: backfillVaultData,
    });
    expect(result.outcome === 'converged' && result.upgraded).toBe(true);
    expect(readFileSync(join(vault, MARKER_FILE), 'utf8')).toContain(
      `schema = ${String(VAULT_SCHEMA)}`,
    );

    const project = readFileSync(join(vault, 'MMR', 'MMR.md'), 'utf8');
    expect(project).toContain('created: 2026-01-01T00:00:00.000Z');
    expect(project).toContain('updated_at: 2026-01-01T00:00:00.000Z');
    expect(readFileSync(join(vault, 'MMR', 'artifacts', 'MMR-a1.md'), 'utf8')).toContain(
      'created: 2026-01-01T04:00:00.000Z',
    );
    expect(readFileSync(join(vault, 'MMR', 'seeds', 'MMR-s1.md'), 'utf8')).toContain(
      'created: 2026-01-01T00:00:00.000Z',
    );
    const pad = readFileSync(
      join(vault, 'scratch', '018f3f36-7b2b-4c92-8f31-44c764a1a456.md'),
      'utf8',
    );
    expect(pad).toContain('created: 2026-01-01T00:00:00.000Z');
    expect(pad).toContain('### 1 — 2026-01-01T00:00:00.000Z');
    // The value no one can interpret is untouched — the migration never guesses,
    // on a pad (`freezing_at`) or on a work-state document (`completed_at`).
    expect(pad).toContain('freezing_at: 2026-01-02T00:00:00');
    expect(readFileSync(join(vault, 'MMR', 'MMR-1.md'), 'utf8')).toContain(
      'completed_at: 2026-01-02T09:00:00',
    );

    // Idempotent: a second pass over the now-canonical vault changes nothing.
    const client = new NornClient({ vaultPath: vault });
    try {
      expect(await backfillCanonicalTimestamps(client, vault)).toEqual([]);
      expect(await backfillJournalTimestamps(client, vault)).toEqual([]);
    } finally {
      await client.close();
    }
  },
);
