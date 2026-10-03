import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'kysely';

import { createInitiative, createPhase, createProject, createTask } from '../create';
import { SCHEMA_VERSION } from '../store-sql/migrator';
import { openSqlite, SQLITE_FILE } from './client';
import { createSqliteStore, readSchemaVersion } from './dialect';

/**
 * The SQLite store's file-backed behavior (ADR 0032 Decision 3): what opening
 * a database does, and how two processes writing one file behave. The seam
 * itself is proven by the conformance suites, which run this backend in
 * memory.
 */

/** The message an awaited rejection carries; a completion fails the case. */
async function refusal(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the call to be refused, but it completed');
}

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mimir-sqlite-'));
  mkdirSync(join(dir, 'data'));
  path = join(dir, 'data', SQLITE_FILE);
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

test('opening a new file creates it, migrates it, and puts it in WAL mode', async () => {
  const handle = await openSqlite(path);
  try {
    expect(handle.upgrade).toEqual({ applied: ['0001_init'], from: 0, to: SCHEMA_VERSION });
    expect(await readSchemaVersion(handle.db)).toBe(SCHEMA_VERSION);
    const mode = await sql<{ journal_mode: string }>`pragma journal_mode`.execute(handle.db);
    expect(mode.rows[0]?.journal_mode).toBe('wal');
    const keys = await sql<{ foreign_keys: number }>`pragma foreign_keys`.execute(handle.db);
    expect(keys.rows[0]?.foreign_keys).toBe(1);
  } finally {
    await handle.close();
  }
});

test('reopening a current store applies nothing and keeps its data', async () => {
  const first = await openSqlite(path);
  await createProject(createSqliteStore(first.db), {
    description: null,
    key: 'MMR',
    name: 'Mimir',
  });
  await first.close();

  const second = await openSqlite(path);
  try {
    expect(second.upgrade.applied).toEqual([]);
    const projects = await createSqliteStore(second.db).loadProjects();
    expect(projects.map((project) => project.key)).toEqual(['MMR']);
  } finally {
    await second.close();
  }
});

test('a store with a newer schema than this binary is refused, not downgraded', async () => {
  const handle = await openSqlite(path);
  await handle.db
    .insertInto('schema_version')
    .values({ applied_at: '2099-01-01T00:00:00.000Z', version: SCHEMA_VERSION + 1 })
    .execute();
  await handle.close();

  expect(await refusal(openSqlite(path))).toContain(
    `the SQLite store schema is version ${String(SCHEMA_VERSION + 1)}`,
  );
});

test('a file holding some other database is refused and left untouched', async () => {
  // The SQLite store Mimir retired at ADR 0016 kept its own tables in the data
  // directory; creating this store's schema around them would fail halfway, or
  // worse, succeed beside a stranger's data.
  const foreign = new Database(path);
  foreign.run('create table project (key text primary key)');
  foreign.close();

  expect(await refusal(openSqlite(path))).toContain('is not a Mimir store');

  const after = new Database(path, { readonly: true });
  try {
    const tables = after
      .query<{ name: string }, []>("select name from sqlite_schema where type = 'table'")
      .all();
    expect(tables.map((table) => table.name)).toEqual(['project']);
    const mode = after.query<{ journal_mode: string }, []>('pragma journal_mode').get();
    expect(mode?.journal_mode).toBe('delete');
  } finally {
    after.close();
  }
});

test('a Store facet called inside transact is refused instead of deadlocking', async () => {
  const handle = await openSqlite(path);
  try {
    const store = createSqliteStore(handle.db);
    // One connection: a facet that waited for it inside the transaction holding
    // it would wait forever.
    const nested = store.transact(() => store.loadProjects());
    expect(await refusal(nested)).toContain('inside an open transaction');
    // The refused transaction released the connection.
    expect(await store.loadProjects()).toEqual([]);
  } finally {
    await handle.close();
  }
});

test('a failure SQLite rolls back itself surfaces as itself, not as a failed rollback', async () => {
  const handle = await openSqlite(path);
  try {
    // Cap the file at its current size so the next sizable write is a full disk,
    // one of the faults after which SQLite has already rolled the transaction back.
    const pages = await sql<{ page_count: number }>`pragma page_count`.execute(handle.db);
    await sql
      .raw(`pragma max_page_count = ${String(pages.rows[0]?.page_count ?? 0)}`)
      .execute(handle.db);
    const store = createSqliteStore(handle.db);
    const message = await refusal(
      store.transact((writer) =>
        writer.insertProject({
          description: 'x'.repeat(1_000_000),
          key: 'MMR',
          name: 'Mimir',
          tags: [],
        }),
      ),
    );
    expect(message).toContain('full');
    expect(message).not.toContain('no transaction is active');
  } finally {
    await handle.close();
  }
});

test("a writer waits out another process's lock without stalling the event loop", async () => {
  const handle = await openSqlite(path);
  // Another connection to the file stands in for another process: its lock is
  // the database's, not this driver's.
  const other = new Database(path);
  try {
    const store = createSqliteStore(handle.db);
    other.run('begin immediate');
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 5);
    const write = store.transact((writer) =>
      writer.insertProject({ description: null, key: 'MMR', name: 'Mimir', tags: [] }),
    );
    await Bun.sleep(250);
    other.run('commit');
    await write;
    clearInterval(timer);
    // A synchronous wait would have frozen the timer for the whole 250ms.
    expect(ticks).toBeGreaterThan(20);
    expect((await store.loadProjects()).map((project) => project.key)).toEqual(['MMR']);
  } finally {
    other.close();
    await handle.close();
  }
});

test('a writer that never gets the lock fails with a conflict, not a raw SQLite error', async () => {
  const handle = await openSqlite(path, { writeWaitMs: 100 });
  const other = new Database(path);
  try {
    other.run('begin immediate');
    const message = await refusal(
      createSqliteStore(handle.db).transact((writer) =>
        writer.insertProject({ description: null, key: 'MMR', name: 'Mimir', tags: [] }),
      ),
    );
    expect(message).toContain('stayed locked by another process');
    other.run('rollback');
  } finally {
    other.close();
    await handle.close();
  }
});

/** Open (and so create and migrate) the store at `path` in a separate process. */
const OPENER = `
  import { openSqlite } from '${new URL('client.ts', import.meta.url).pathname}';
  const handle = await openSqlite(process.argv[1]);
  await handle.close();
`;

test('processes racing to open one fresh file all open it', async () => {
  // A fresh install starts the daemon, MCP servers, and a CLI command at once.
  for (let round = 0; round < 4; round++) {
    const fresh = join(dir, 'data', `race-${String(round)}.sqlite`);
    const openers = Array.from({ length: 8 }, () =>
      Bun.spawn(['bun', '-e', OPENER, fresh], { stderr: 'pipe', stdout: 'pipe' }),
    );
    const exits = await Promise.all(openers.map((opener) => opener.exited));
    for (const [index, code] of exits.entries()) {
      if (code !== 0) {
        throw new Error(await new Response(openers[index]?.stderr).text());
      }
    }
  }
}, 60_000);

/** The worker script, addressed by path — it is spawned, never imported. */
const WORKER = new URL('testing-concurrency-worker.ts', import.meta.url).pathname;

/** How many tasks, and how many contended patches, EACH worker process lands. */
const TASKS = 25;
const PATCHES = 20;

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

test('two processes writing one file lose no identity and no update', async () => {
  const handle = await openSqlite(path);
  try {
    const store = createSqliteStore(handle.db);
    await createProject(store, { description: null, key: 'MMR', name: 'Mimir' });
    const initiative = await createInitiative(store, {
      description: null,
      projectId: 'MMR',
      title: 'Local store',
    });
    const phase = await createPhase(store, { parentId: initiative.id, title: 'Phase A' });
    const shared = await createTask(store, { parentId: phase.id, title: 'contended' });
    const baseRank = shared.rank ?? 0;
    const seeded = 3; // the initiative, the phase, and the contended task

    await race([path, 'create', phase.id, '@label', String(TASKS)]);

    const expected = seeded + 2 * TASKS;
    const nodes = await handle.db
      .selectFrom('node')
      .select('seq')
      .where('project_key', '=', 'MMR')
      .orderBy('seq')
      .execute();
    // An exact contiguous range: every allocation was its own, none skipped.
    expect(nodes.map((row) => row.seq)).toEqual(
      Array.from({ length: expected }, (_, index) => index + 1),
    );

    await race([path, 'patch', shared.id, '@label', String(PATCHES)]);

    // Every annotation landed and every increment survived.
    const annotations = await handle.db
      .selectFrom('annotation')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('node_id', '=', shared.id)
      .executeTakeFirst();
    expect(annotations?.count).toBe(2 * PATCHES);
    const node = await handle.db
      .selectFrom('node')
      .select('rank')
      .where('id', '=', shared.id)
      .executeTakeFirst();
    expect(node?.rank).toBe(baseRank + 2 * PATCHES);
  } finally {
    await handle.close();
  }
}, 60_000);
