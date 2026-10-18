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
import { statements as initStatements } from './migrations/0001-init';
import { statements as groomingStatements } from './migrations/0002-grooming';
import { statements as blockOwnerStatements } from './migrations/0003-block-owner';
import { statements as seedParkedStatements } from './migrations/0004-seed-parked';

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
    expect(handle.upgrade).toEqual({
      applied: [
        '0001_init',
        '0002_grooming',
        '0003_block_owner',
        '0004_seed_parked',
        '0005_project_pinned',
        '0006_project_remote',
      ],
      from: 0,
      to: SCHEMA_VERSION,
    });
    expect(await readSchemaVersion(handle.db)).toBe(SCHEMA_VERSION);
    const mode = await sql<{ journal_mode: string }>`pragma journal_mode`.execute(handle.db);
    expect(mode.rows[0]?.journal_mode).toBe('wal');
    const keys = await sql<{ foreign_keys: number }>`pragma foreign_keys`.execute(handle.db);
    expect(keys.rows[0]?.foreign_keys).toBe(1);
  } finally {
    await handle.close();
  }
});

test('0002_grooming upgrades a version-1 store: tasks not_groomed, containers NULL, bogus values rejected', async () => {
  // Build the store as the previous binary left it: only 0001, with live rows.
  const old = new Database(path, { create: true });
  for (const statement of initStatements) {
    old.run(statement);
  }
  old.run(
    `INSERT INTO schema_version (version, applied_at) VALUES (1, '2026-09-01T00:00:00.000Z')`,
  );
  old.run(
    `INSERT INTO project (key, name, created_at, updated_at) VALUES ('MMR', 'Mimir', 't', 't')`,
  );
  const node = (id: string, seq: number, type: string, task: boolean) =>
    old.run(
      `INSERT INTO node (id, project_key, type, seq, title, lifecycle, hold, created_at, updated_at)
       VALUES ('${id}', 'MMR', '${type}', ${String(seq)}, 't', ${task ? "'todo'" : 'NULL'}, ${task ? "'none'" : 'NULL'}, 't', 't')`,
    );
  node('MMR-1', 1, 'initiative', false);
  node('MMR-2', 2, 'phase', false);
  node('MMR-3', 3, 'task', true);
  old.close();

  const handle = await openSqlite(path);
  try {
    expect(handle.upgrade).toEqual({
      applied: [
        '0002_grooming',
        '0003_block_owner',
        '0004_seed_parked',
        '0005_project_pinned',
        '0006_project_remote',
      ],
      from: 1,
      to: SCHEMA_VERSION,
    });
    const rows = await sql<{ id: string; grooming: string | null }>`
      select id, grooming from node order by seq
    `.execute(handle.db);
    expect(rows.rows).toEqual([
      { grooming: null, id: 'MMR-1' },
      { grooming: null, id: 'MMR-2' },
      { grooming: 'not_groomed', id: 'MMR-3' },
    ]);
    expect(
      await refusal(sql`update node set grooming = 'bogus' where id = 'MMR-3'`.execute(handle.db)),
    ).toContain('CHECK');
  } finally {
    await handle.close();
  }
});

test('0003_block_owner upgrades a version-2 store: blocked tasks get an owner by their upstream, everything else NULL, bogus values rejected', async () => {
  // The store as the previous binary left it: 0001 + 0002, with live rows.
  const old = new Database(path, { create: true });
  for (const statement of [...initStatements, ...groomingStatements]) {
    old.run(statement);
  }
  old.run(
    `INSERT INTO schema_version (version, applied_at) VALUES (1, '2026-09-01T00:00:00.000Z'), (2, '2026-09-02T00:00:00.000Z')`,
  );
  old.run(
    `INSERT INTO project (key, name, created_at, updated_at) VALUES ('MMR', 'Mimir', 't', 't')`,
  );
  const node = (seq: number, type: string, hold: string | null, upstream: string | null) =>
    old.run(
      `INSERT INTO node (id, project_key, type, seq, title, lifecycle, hold, upstream, created_at, updated_at)
       VALUES ('MMR-${String(seq)}', 'MMR', '${type}', ${String(seq)}, 't', ${type === 'task' ? "'todo'" : 'NULL'}, ${hold === null ? 'NULL' : `'${hold}'`}, ${upstream === null ? 'NULL' : `'${upstream}'`}, 't', 't')`,
    );
  node(1, 'initiative', null, null);
  node(2, 'task', 'blocked', 'OPS-s4');
  node(3, 'task', 'blocked', null);
  node(4, 'task', 'parked', 'OPS-s5');
  node(5, 'task', 'none', 'OPS-s6');
  old.close();

  const handle = await openSqlite(path);
  try {
    expect(handle.upgrade).toEqual({
      applied: [
        '0003_block_owner',
        '0004_seed_parked',
        '0005_project_pinned',
        '0006_project_remote',
      ],
      from: 2,
      to: SCHEMA_VERSION,
    });
    const rows = await sql<{ id: string; block_owner: string | null }>`
      select id, block_owner from node order by seq
    `.execute(handle.db);
    expect(rows.rows).toEqual([
      { block_owner: null, id: 'MMR-1' },
      { block_owner: 'others', id: 'MMR-2' },
      { block_owner: 'you', id: 'MMR-3' },
      { block_owner: null, id: 'MMR-4' },
      { block_owner: null, id: 'MMR-5' },
    ]);
    expect(
      await refusal(
        sql`update node set block_owner = 'bogus' where id = 'MMR-3'`.execute(handle.db),
      ),
    ).toContain('CHECK');
  } finally {
    await handle.close();
  }
});

test('0004_seed_parked upgrades a version-3 store: seeds and their history survive, parked is admitted, bogus values rejected', async () => {
  // The store as the previous binary left it: 0001–0003, with a seed and its history.
  const old = new Database(path, { create: true });
  for (const statement of [...initStatements, ...groomingStatements, ...blockOwnerStatements]) {
    old.run(statement);
  }
  old.run(`INSERT INTO schema_version (version, applied_at) VALUES (1, 't'), (2, 't'), (3, 't')`);
  old.run(
    `INSERT INTO project (key, name, created_at, updated_at) VALUES ('MMR', 'Mimir', 't', 't')`,
  );
  old.run(
    `INSERT INTO seed (id, project_key, seq, title, kind, lifecycle, requester, description, spawned, created_at, updated_at)
     VALUES ('MMR-s1', 'MMR', 1, 'kept', 'idea', 'promoted', NULL, 'body', '["MMR-9"]', 'c', 'u'),
            ('MMR-s2', 'MMR', 2, 'fresh', 'bug', 'new', NULL, NULL, '[]', 'c', 'u')`,
  );
  old.run(
    `INSERT INTO seed_history (id, seed_id, kind, from_value, to_value, reason, at)
     VALUES (7, 'MMR-s1', 'lifecycle', 'new', 'promoted', 'promoted — spawned MMR-9', 'h')`,
  );
  // History ids past the highest surviving row were handed out once; the counter
  // must keep counting from there, never reuse them.
  old.run(`UPDATE sqlite_sequence SET seq = 12 WHERE name = 'seed_history'`);
  // The previous schema refuses the new word, so the upgrade is what admits it.
  expect(() => old.run(`UPDATE seed SET lifecycle = 'parked' WHERE id = 'MMR-s2'`)).toThrow(
    'CHECK',
  );
  old.close();

  const handle = await openSqlite(path);
  try {
    expect(handle.upgrade).toEqual({
      applied: ['0004_seed_parked', '0005_project_pinned', '0006_project_remote'],
      from: 3,
      to: SCHEMA_VERSION,
    });
    const seeds = await sql<{
      id: string;
      lifecycle: string;
      spawned: string;
      description: string | null;
    }>`
      select id, lifecycle, spawned, description from seed order by seq
    `.execute(handle.db);
    expect(seeds.rows).toEqual([
      { description: 'body', id: 'MMR-s1', lifecycle: 'promoted', spawned: '["MMR-9"]' },
      { description: null, id: 'MMR-s2', lifecycle: 'new', spawned: '[]' },
    ]);
    const history = await sql<{ id: number; seed_id: string; reason: string }>`
      select id, seed_id, reason from seed_history
    `.execute(handle.db);
    expect(history.rows).toEqual([
      { id: 7, reason: 'promoted — spawned MMR-9', seed_id: 'MMR-s1' },
    ]);

    await sql`update seed set lifecycle = 'parked' where id = 'MMR-s2'`.execute(handle.db);
    expect(
      await refusal(
        sql`update seed set lifecycle = 'bogus' where id = 'MMR-s2'`.execute(handle.db),
      ),
    ).toContain('CHECK');
    // The history still references the seed table, and its index survived the rebuild.
    expect(
      await refusal(
        sql`insert into seed_history (seed_id, kind, at) values ('MMR-s99', 'lifecycle', 'h')`.execute(
          handle.db,
        ),
      ),
    ).toContain('FOREIGN KEY');
    const index = await sql<{ name: string }>`
      select name from sqlite_master where type = 'index' and tbl_name = 'seed_history'
    `.execute(handle.db);
    expect(index.rows.map((row) => row.name)).toContain('idx_seed_history_seed');
    // New history rows keep counting past every id ever handed out.
    await sql`insert into seed_history (seed_id, kind, at) values ('MMR-s2', 'lifecycle', 'h')`.execute(
      handle.db,
    );
    const ids = await sql<{ id: number }>`select id from seed_history order by id`.execute(
      handle.db,
    );
    expect(ids.rows.map((row) => row.id)).toEqual([7, 13]);
  } finally {
    await handle.close();
  }
});

test('0005_project_pinned upgrades a version-4 store: projects keep their data and read unpinned, only 0 and 1 are admitted', async () => {
  // The store as the previous binary left it: 0001–0004, with two live projects.
  const old = new Database(path, { create: true });
  for (const statement of [
    ...initStatements,
    ...groomingStatements,
    ...blockOwnerStatements,
    ...seedParkedStatements,
  ]) {
    old.run(statement);
  }
  old.run(
    `INSERT INTO schema_version (version, applied_at) VALUES (1, 't'), (2, 't'), (3, 't'), (4, 't')`,
  );
  old.run(
    `INSERT INTO project (key, name, description, last_seq, created_at, updated_at)
     VALUES ('MMR', 'Mimir', 'the store', 7, 'c', 'u'), ('OPS', 'Ops', NULL, 0, 'c', 'u')`,
  );
  old.close();

  const handle = await openSqlite(path);
  try {
    expect(handle.upgrade).toEqual({
      applied: ['0005_project_pinned', '0006_project_remote'],
      from: 4,
      to: SCHEMA_VERSION,
    });
    const rows = await sql<{
      key: string;
      description: string | null;
      last_seq: number;
      pinned: number;
    }>`
      select key, description, last_seq, pinned from project order by key
    `.execute(handle.db);
    expect(rows.rows).toEqual([
      { description: 'the store', key: 'MMR', last_seq: 7, pinned: 0 },
      { description: null, key: 'OPS', last_seq: 0, pinned: 0 },
    ]);
    await sql`update project set pinned = 1 where key = 'MMR'`.execute(handle.db);
    expect(
      await refusal(sql`update project set pinned = 2 where key = 'MMR'`.execute(handle.db)),
    ).toContain('CHECK');
    expect(
      await refusal(sql`update project set pinned = NULL where key = 'MMR'`.execute(handle.db)),
    ).toContain('NOT NULL');
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
    // The longest the event loop went without running a timer while the write
    // waited. A synchronous wait would hold it for the whole busy timeout —
    // and, here, past the release, which only the event loop can run.
    let last = performance.now();
    let longest = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
    }, 5);
    const write = store.transact((writer) =>
      writer.insertProject({ description: null, key: 'MMR', name: 'Mimir', tags: [] }),
    );
    const held = 600;
    await Bun.sleep(held);
    other.run('commit');
    await write;
    clearInterval(timer);
    expect(longest).toBeLessThan(held / 2);
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
