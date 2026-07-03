import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNornArtifactStore, restoreArtifact } from '../core/artifacts/norn';
import type { ArtifactRecord, ArtifactStore } from '../core/artifacts/store';
import { createInitiative, createProject, createTask } from '../core/create';
import { renderNodeId } from '../core/lookup';
import { createSqliteStore } from '../core/store-sqlite';
import { createTestDb } from '../db/testing';
import { bunExec } from '../exec';
import { NornClient } from '../norn/client';
import { converge } from '../vault/converge';
import { migrateArtifacts } from './migrate-artifacts';
import type { ArtifactRestore } from './migrate-artifacts';

/**
 * MMR-144: the artifact backfill. The orchestration is tested pure (a fake
 * source + a fake restore, no norn); a norn-gated arm exercises the real
 * `restoreArtifact` end-to-end for identity/timestamp parity and re-run
 * idempotency, mirroring the conformance harness.
 */

const NORN = Bun.which('norn') !== null;

/** Seam methods the migration must never call — a source is read-only. */
const unusedMethod = (): never => {
  throw new Error('migration should not call this method');
};

/** A source store that only answers the two reads the migration makes. */
function fakeSource(
  byProject: Record<string, { record: ArtifactRecord; content: string }[]>,
): ArtifactStore {
  return {
    applyTag: unusedMethod,
    create: unusedMethod,
    list: unusedMethod,
    listForNode: unusedMethod,
    async listForProject(key) {
      return (byProject[key] ?? []).map((a) => a.record);
    },
    async load(key, seq, opts) {
      const hit = (byProject[key] ?? []).find((a) => a.record.seq === seq);
      if (hit === undefined) {
        return undefined;
      }
      return opts?.content === true ? { ...hit.record, content: hit.content } : hit.record;
    },
    removeTags: unusedMethod,
    updateTitle: unusedMethod,
  };
}

/** A restore that always reports a fresh write (captures nothing). */
const alwaysCreate: ArtifactRestore = async () => 'created';

function rec(key: string, seq: number): ArtifactRecord {
  return {
    created_at: '2026-01-01T00:00:00.000Z',
    key,
    links: [],
    seq,
    tags: [],
    title: `t${seq}`,
  };
}

describe('migrateArtifacts (orchestration)', () => {
  test('copies every artifact across projects and tallies created/skipped', async () => {
    const source = fakeSource({
      ALPHA: [
        { content: 'a1', record: rec('ALPHA', 1) },
        { content: 'a2', record: rec('ALPHA', 2) },
      ],
      BETA: [{ content: 'b1', record: rec('BETA', 1) }],
    });
    const seen: { key: string; seq: number; content: string }[] = [];
    // BETA-1 reports already-present → skipped; the rest are created.
    const restore: ArtifactRestore = async (record, content) => {
      seen.push({ content, key: record.key, seq: record.seq });
      return record.key === 'BETA' ? 'skipped' : 'created';
    };

    const report = await migrateArtifacts(source, ['ALPHA', 'BETA'], restore);

    expect(report).toEqual({ created: 2, dryRun: false, projects: 2, skipped: 1, total: 3 });
    expect(seen).toEqual([
      { content: 'a1', key: 'ALPHA', seq: 1 },
      { content: 'a2', key: 'ALPHA', seq: 2 },
      { content: 'b1', key: 'BETA', seq: 1 },
    ]);
  });

  test('dry-run counts the inventory and never writes', async () => {
    const source = fakeSource({ ALPHA: [{ content: 'a1', record: rec('ALPHA', 1) }] });
    let calls = 0;
    const restore: ArtifactRestore = async () => {
      calls += 1;
      return 'created';
    };

    const report = await migrateArtifacts(source, ['ALPHA'], restore, { dryRun: true });

    expect(report).toEqual({ created: 0, dryRun: true, projects: 1, skipped: 0, total: 1 });
    expect(calls).toBe(0);
  });

  test('an artifact that vanishes between list and load is skipped, not copied', async () => {
    // listForProject reports seq 1 and 2, but load only resolves seq 1.
    const source: ArtifactStore = {
      ...fakeSource({}),
      async listForProject() {
        return [rec('ALPHA', 1), rec('ALPHA', 2)];
      },
      async load(_key, seq, opts) {
        if (seq !== 1) {
          return undefined;
        }
        const record = rec('ALPHA', 1);
        return opts?.content === true ? { ...record, content: 'a1' } : record;
      },
    };

    const report = await migrateArtifacts(source, ['ALPHA'], alwaysCreate);

    expect(report.total).toBe(1); // only the resolvable one counts
    expect(report.created).toBe(1);
  });
});

describe.skipIf(!NORN)('migrateArtifacts → vault (end-to-end)', () => {
  let root: string;
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let client: NornClient;
  let source: ArtifactStore;
  let stems: string[];

  beforeEach(async () => {
    db = await createTestDb();
    const store = createSqliteStore(db);
    source = store.artifacts;
    const project = await createProject(store, { key: 'MMR', name: 'MMR' });
    const init = await createInitiative(store, { projectId: project.id, title: 'i' });
    stems = [];
    for (const title of ['n1', 'n2']) {
      const task = await createTask(store, { parentId: init.id, title });
      stems.push((await renderNodeId(db, task.id)) ?? 'unknown');
    }
    root = mkdtempSync(join(tmpdir(), 'mimir-migrate-'));
    await converge(join(root, 'vault'), { allowCreate: true, exec: bunExec });
    client = new NornClient({ vaultPath: join(root, 'vault') });
  });

  afterEach(async () => {
    await client.close();
    await db.destroy();
    rmSync(root, { force: true, recursive: true });
  });

  const restore: ArtifactRestore = (record, content) => restoreArtifact(client, record, content);

  test('preserves KEY-aN identity, created, links, tags, and content', async () => {
    await source.create({
      content: '# spec\n\nbody',
      key: 'MMR',
      links: [stems[0] ?? ''],
      tags: ['spec', 'v1'],
      title: 'A spec',
    });
    await source.create({ content: 'log body', key: 'MMR', links: [], tags: [], title: 'A log' });
    const originals = await Promise.all([
      source.load('MMR', 1, { content: true }),
      source.load('MMR', 2, { content: true }),
    ]);

    const report = await migrateArtifacts(source, ['MMR'], restore);
    expect(report).toMatchObject({ created: 2, skipped: 0, total: 2 });

    const dest = createNornArtifactStore(client);
    for (const original of originals) {
      const copied = await dest.load('MMR', original?.seq ?? -1, { content: true });
      expect(copied).toMatchObject({
        content: original?.content,
        created_at: original?.created_at, // the source timestamp, not a fresh now()
        key: 'MMR',
        seq: original?.seq,
        tags: original?.tags ?? [],
        title: original?.title,
      });
      expect(copied?.links.toSorted()).toEqual((original?.links ?? []).toSorted());
    }
  });

  test('re-running is idempotent — every artifact skipped, no duplicates', async () => {
    await source.create({ content: 'x', key: 'MMR', links: [], tags: [], title: 'x' });
    await source.create({ content: 'y', key: 'MMR', links: [], tags: [], title: 'y' });

    const first = await migrateArtifacts(source, ['MMR'], restore);
    expect(first).toMatchObject({ created: 2, skipped: 0, total: 2 });

    const second = await migrateArtifacts(source, ['MMR'], restore);
    expect(second).toMatchObject({ created: 0, skipped: 2, total: 2 });

    // The vault holds exactly two artifacts — no re-sequenced duplicates.
    const inventory = await createNornArtifactStore(client).listForProject('MMR');
    expect(inventory.map((r) => r.seq)).toEqual([1, 2]);
  });

  test('a stem occupied by a different artifact fails loudly, not silent skip', async () => {
    // Seed the vault with a foreign artifact at MMR-a1 (its own created/title).
    await createNornArtifactStore(client).create({
      content: 'foreign body',
      key: 'MMR',
      links: [],
      tags: [],
      title: 'foreign',
    });
    // A source artifact colliding on the same stem but with a different identity
    // must not be reported skipped — that would hide a source/dest divergence.
    const divergent: ArtifactRecord = {
      created_at: '2020-01-01T00:00:00.000Z',
      key: 'MMR',
      links: [],
      seq: 1,
      tags: [],
      title: 'the real MMR-a1',
    };
    expect(restoreArtifact(client, divergent, 'real body')).rejects.toThrow(/already exists/i);
  });
});
