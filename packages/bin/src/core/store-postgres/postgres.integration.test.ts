import { expect, test } from 'bun:test';

import { sql } from 'kysely';

import { sandboxAuthorityFromEnvironment } from '../../sandbox-authority';
import { observe, seedWorkingSet, withoutStamp } from '../../testing/conformance';
import { createInitiative, createPhase, createProject, createTask } from '../create';
import { updateNode } from '../mutations';
import { openPostgres } from './client';
import { assertSchemaCurrent, readSchemaVersion, SCHEMA_VERSION, upgradeSchema } from './migrator';
import { createPostgresStore } from './store';
import { createThrowawaySchema } from './testing';

/**
 * The real-Postgres lane (ADR 0030). The ordinary suite runs the backend on
 * PGlite, which is real PostgreSQL but not the real client: `pg` over a socket
 * parses types, pools connections, and reports SQLSTATEs through its own path,
 * and only a server can be written to by two operating-system processes at
 * once. This lane guards that seam and the concurrency claim behind it.
 *
 * Each case owns a throwaway SQL schema, so a run neither sees nor disturbs
 * anything else in the database, and drops it afterwards.
 *
 * Run `bun run sandbox test`; its authority enables this disposable-server lane.
 */
const POSTGRES_URL = sandboxAuthorityFromEnvironment()?.postgresUrl;
const lane = test.skipIf(POSTGRES_URL === undefined);

/** How many tasks, and how many contended patches, EACH worker process lands.
 * The two races run one after the other: mixing the two kinds of write would
 * measure a hot spot rather than a race (see the worker's header). */
const TASKS = 25;
const PATCHES = 20;

/** Run `body` against a fresh, empty schema, dropping it afterwards. */
async function onFreshSchema<T>(body: (url: string) => Promise<T>): Promise<T> {
  const schema = await createThrowawaySchema(POSTGRES_URL ?? '');
  try {
    return await body(schema.url);
  } finally {
    await schema.drop();
  }
}

lane('upgradeSchema builds the schema from empty, and the gate then passes', async () => {
  await onFreshSchema(async (url) => {
    const handle = openPostgres(url);
    try {
      expect(await readSchemaVersion(handle.db)).toBeNull();
      const report = await upgradeSchema(handle.db);
      expect(report).toEqual({ applied: ['0001_init'], from: 0, to: SCHEMA_VERSION });
      // The gate is the thing the whole schema posture rests on: it must accept
      // exactly what the migrator just produced.
      await assertSchemaCurrent(handle.db);
      expect(await readSchemaVersion(handle.db)).toBe(SCHEMA_VERSION);
    } finally {
      await handle.close();
    }
  });
});

lane('the conformance fixture round trips through export and import on real Postgres', async () => {
  await onFreshSchema(async (sourceUrl) => {
    await onFreshSchema(async (targetUrl) => {
      const source = openPostgres(sourceUrl);
      const target = openPostgres(targetUrl);
      try {
        await upgradeSchema(source.db);
        await upgradeSchema(target.db);
        const from = createPostgresStore(source.db);
        const into = createPostgresStore(target.db);

        await seedWorkingSet(from);
        const document = await from.export();
        const report = await into.import(document, { dryRun: false, mode: 'fresh' });
        expect(report.mode).toBe('fresh');
        expect(report.created).toBeGreaterThan(0);

        // Identity, timestamps, and counters all preserved: the two stores read
        // back the same facts, and re-exporting reproduces the same document.
        expect(await observe(into)).toEqual(await observe(from));
        expect(withoutStamp(await into.export())).toEqual(withoutStamp(document));
      } finally {
        await target.close();
        await source.close();
      }
    });
  });
});

lane('two concurrent upgrades from empty apply each migration exactly once', async () => {
  await onFreshSchema(async (url) => {
    const first = openPostgres(url);
    const second = openPostgres(url);
    try {
      const reports = await Promise.all([upgradeSchema(first.db), upgradeSchema(second.db)]);
      // The advisory lock serializes them and the loser re-reads the version
      // inside the lock, so exactly one run reports the migration as applied.
      expect(reports.map((report) => report.applied.length).toSorted((x, y) => x - y)).toEqual([
        0, 1,
      ]);
      expect(reports.map((report) => report.to)).toEqual([SCHEMA_VERSION, SCHEMA_VERSION]);
      // `count(*)` is a bigint: node-postgres hands it back as a string.
      const rows = await sql<{ count: string }>`
        select count(*) as count from schema_version
      `.execute(first.db);
      expect(Number(rows.rows[0]?.count)).toBe(SCHEMA_VERSION);
    } finally {
      await second.close();
      await first.close();
    }
  });
});

lane(
  'concurrent ## Next rewrites through the verb all settle',
  async () => {
    // The regression for the pooled-connection deadlock (MMR-379): `updateNode`
    // reads the current `## Next` before re-authoring it. While that read went
    // through the `Store` facet it took a SECOND pooled connection inside an
    // open transaction, so once the writers outnumbered the pool (`pg` defaults
    // to 10) every one of them held a connection and waited for one that would
    // never come. It cannot be expressed on PGlite, which has a single
    // in-process connection every read silently joins.
    const WRITERS = 12;
    await onFreshSchema(async (url) => {
      const handle = openPostgres(url);
      try {
        await upgradeSchema(handle.db);
        const store = createPostgresStore(handle.db);
        await createProject(store, { description: null, key: 'MMR', name: 'Mimir' });
        const containers = [];
        for (let index = 0; index < WRITERS; index += 1) {
          containers.push(
            await createInitiative(store, { projectId: 'MMR', title: `Initiative ${index}` }),
          );
        }

        // A deadlocked pool presents as a wall-clock hang: every writer holds a
        // connection and waits for one nobody will release. The bound is what
        // separates "slow under contention" from "will never finish".
        const started = performance.now();
        await Promise.all(
          containers.map((node) => updateNode(store, node.id, { next: `next for ${node.id}` })),
        );
        expect(performance.now() - started).toBeLessThan(20_000);

        const written = await sql<{ id: string; next_text: string }>`
          select id, next_text from node where next_present order by id
        `.execute(handle.db);
        expect(written.rows.length).toBe(WRITERS);
        for (const row of written.rows) {
          expect(row.next_text).toContain(row.id);
        }
      } finally {
        await handle.close();
      }
    });
  },
  60_000,
);

/** The worker script, addressed by path — it is spawned, never imported. */
const WORKER = new URL('testing-concurrency-worker.ts', import.meta.url).pathname;

/** Race two worker processes doing the same work, and fail with their stderr. */
async function race(args: readonly string[]): Promise<void> {
  const workers = ['a', 'b'].map((label) =>
    Bun.spawn(['bun', WORKER, ...args.map((arg) => (arg === '@label' ? label : arg))], {
      stderr: 'pipe',
      stdout: 'pipe',
    }),
  );
  const exits = await Promise.all(workers.map((worker) => worker.exited));
  for (const [index, code] of exits.entries()) {
    if (code !== 0) {
      throw new Error(await new Response(workers[index]?.stderr).text());
    }
  }
}

lane(
  'two processes writing one project lose no identity and no update',
  async () => {
    await onFreshSchema(async (url) => {
      const handle = openPostgres(url);
      try {
        await upgradeSchema(handle.db);
        const store = createPostgresStore(handle.db);
        await createProject(store, { description: null, key: 'MMR', name: 'Mimir' });
        const initiative = await createInitiative(store, {
          description: null,
          projectId: 'MMR',
          title: 'Shared store',
        });
        const phase = await createPhase(store, { parentId: initiative.id, title: 'Phase A' });
        const shared = await createTask(store, { parentId: phase.id, title: 'contended' });
        const baseRank = shared.rank ?? 0;
        const seeded = 3; // the initiative, the phase, and the contended task

        await race([url, 'create', phase.id, '@label', String(TASKS)]);

        const expected = seeded + 2 * TASKS;
        const nodes = await sql<{ seq: number }>`
          select seq from node where project_key = 'MMR' order by seq
        `.execute(handle.db);
        // An exact contiguous range, no gap and no repeat: every allocation the
        // two processes made was its own, and none was skipped.
        expect(nodes.rows.map((row) => row.seq)).toEqual(
          Array.from({ length: expected }, (_, index) => index + 1),
        );
        const project = await sql<{ last_seq: number }>`
          select last_seq from project where key = 'MMR'
        `.execute(handle.db);
        expect(project.rows[0]?.last_seq).toBe(expected);

        await race([url, 'patch', shared.id, '@label', String(PATCHES)]);

        // The contended read-modify-write: every annotation landed and every
        // increment survived, so no transaction overwrote another's read.
        const annotations = await sql<{ count: string }>`
          select count(*) as count from annotation where node_id = ${shared.id}
        `.execute(handle.db);
        expect(Number(annotations.rows[0]?.count)).toBe(2 * PATCHES);
        const patched = await sql<{ rank: number }>`
          select rank from node where id = ${shared.id}
        `.execute(handle.db);
        expect(patched.rows[0]?.rank).toBe(baseRank + 2 * PATCHES);
      } finally {
        await handle.close();
      }
    });
  },
  60_000,
);
