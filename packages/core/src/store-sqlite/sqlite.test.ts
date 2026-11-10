import { Database } from 'bun:sqlite';
import type { Changes, Statement } from 'bun:sqlite';
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'kysely';

import { createInitiative, createPhase, createProject, createTask } from '../create';
import { SCHEMA_VERSION } from '../store-sql/migrator';
import { pairTestDevice } from '../testing/store';
import { createTokenStore } from '../tokens';
import { openExistingSqlite, openSqlite, SQLITE_FILE } from './client';
import { createSqliteStore, readSchemaVersion, sqliteDialect } from './dialect';
import { statements as initStatements } from './migrations/0001-init';
import { statements as groomingStatements } from './migrations/0002-grooming';
import { statements as blockOwnerStatements } from './migrations/0003-block-owner';
import { statements as seedParkedStatements } from './migrations/0004-seed-parked';
import { statements as projectPinnedStatements } from './migrations/0005-project-pinned';
import { statements as projectRemoteStatements } from './migrations/0006-project-remote';
import { statements as taskQueuedStatements } from './migrations/0007-task-queued';
import { statements as mainWorkerStatements } from './migrations/0008-main-worker';
import { statements as deviceTokensStatements } from './migrations/0009-device-tokens';
import { statements as pairingRequestsStatements } from './migrations/0010-pairing-requests';
import { statements as terminalHoldStatements } from './migrations/0011-terminal-hold';
import { statements as hostSecretsStatements } from './migrations/0012-host-secrets';

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

/** A nullable text value as a SQL literal, for seeding rows the way an older binary wrote them. */
function sqlLiteral(value: string | null): string {
  return value === null ? 'NULL' : `'${value}'`;
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
        '0007_task_queued',
        '0008_main_worker',
        '0009_device_tokens',
        '0010_pairing_requests',
        '0011_terminal_hold',
        '0012_host_secrets',
        '0013_runs',
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
        '0007_task_queued',
        '0008_main_worker',
        '0009_device_tokens',
        '0010_pairing_requests',
        '0011_terminal_hold',
        '0012_host_secrets',
        '0013_runs',
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
        '0007_task_queued',
        '0008_main_worker',
        '0009_device_tokens',
        '0010_pairing_requests',
        '0011_terminal_hold',
        '0012_host_secrets',
        '0013_runs',
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
      applied: [
        '0004_seed_parked',
        '0005_project_pinned',
        '0006_project_remote',
        '0007_task_queued',
        '0008_main_worker',
        '0009_device_tokens',
        '0010_pairing_requests',
        '0011_terminal_hold',
        '0012_host_secrets',
        '0013_runs',
      ],
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
      applied: [
        '0005_project_pinned',
        '0006_project_remote',
        '0007_task_queued',
        '0008_main_worker',
        '0009_device_tokens',
        '0010_pairing_requests',
        '0011_terminal_hold',
        '0012_host_secrets',
        '0013_runs',
      ],
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

test('0006_project_remote upgrades a version-5 store: projects keep their data and read with no remote', async () => {
  const old = new Database(path, { create: true });
  for (const statement of [
    ...initStatements,
    ...groomingStatements,
    ...blockOwnerStatements,
    ...seedParkedStatements,
    ...projectPinnedStatements,
  ]) {
    old.run(statement);
  }
  old.run(
    `INSERT INTO schema_version (version, applied_at) VALUES (1, 't'), (2, 't'), (3, 't'), (4, 't'), (5, 't')`,
  );
  old.run(
    `INSERT INTO project (key, name, description, last_seq, pinned, created_at, updated_at)
     VALUES ('MMR', 'Mimir', 'the store', 7, 1, 'c', 'u'), ('OPS', 'Ops', NULL, 0, 0, 'c', 'u')`,
  );
  old.close();

  const handle = await openSqlite(path);
  try {
    expect(handle.upgrade).toEqual({
      applied: [
        '0006_project_remote',
        '0007_task_queued',
        '0008_main_worker',
        '0009_device_tokens',
        '0010_pairing_requests',
        '0011_terminal_hold',
        '0012_host_secrets',
        '0013_runs',
      ],
      from: 5,
      to: SCHEMA_VERSION,
    });
    const rows = await sql<{
      key: string;
      description: string | null;
      last_seq: number;
      pinned: number;
      remote: string | null;
    }>`
      select key, description, last_seq, pinned, remote from project order by key
    `.execute(handle.db);
    expect(rows.rows).toEqual([
      {
        description: 'the store',
        key: 'MMR',
        last_seq: 7,
        pinned: 1,
        remote: null,
      },
      { description: null, key: 'OPS', last_seq: 0, pinned: 0, remote: null },
    ]);
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

/**
 * Another connection to the file, standing in for another opener. It never
 * waits for a lock, so taking one it cannot get fails at once instead of
 * blocking the test's only thread.
 */
function otherOpener(file: string): Database {
  const other = new Database(file);
  other.run('pragma busy_timeout = 0');
  return other;
}

/**
 * The two `bun:sqlite` methods an open runs its statements through, as it calls
 * them: with the SQL text alone. The tests below wrap them to set up another
 * opener's lock at one exact statement.
 */
type Statements = {
  run: (this: Database, query: string) => Changes;
  prepare: (this: Database, query: string) => Statement;
};
const statements: Statements = Database.prototype;

test("an opener's switch to WAL waits out another opener's write lock", async () => {
  // On a fresh file still in rollback mode, SQLite refuses the switch at once,
  // without its busy wait, while another opener holds the write lock.
  const other = otherOpener(path);
  const run = statements.run;
  let switches = 0;
  let release: Timer | undefined;
  const spy = spyOn(statements, 'run').mockImplementation(function runAfterOtherLocks(query) {
    if (this !== other && query === 'pragma journal_mode = wal') {
      switches += 1;
      if (switches === 1) {
        // The other opener takes the lock just as this one switches, and
        // gives it up only once the event loop runs again.
        other.run('begin immediate');
        release = setTimeout(() => other.run('commit'), 50);
      }
    }
    return run.call(this, query);
  });
  try {
    const handle = await openSqlite(path);
    try {
      const mode = await sql<{ journal_mode: string }>`pragma journal_mode`.execute(handle.db);
      expect(mode.rows[0]?.journal_mode).toBe('wal');
    } finally {
      await handle.close();
    }
    // The first switch met the held lock; a later one got through.
    expect(switches).toBeGreaterThan(1);
  } finally {
    spy.mockRestore();
    clearTimeout(release);
    if (other.inTransaction) {
      other.run('rollback');
    }
    other.close();
  }
});

test('an opener holds the write lock while it decides whether a file is foreign', async () => {
  // Apart, another opener could create the schema between the read of the
  // version and the read of the tables, and the fresh file would read as some
  // other program's database.
  const other = otherOpener(path);
  const prepare = statements.prepare;
  let span: 'before' | 'between the reads' | 'after' = 'before';
  const tries: ('locked out' | 'took the lock')[] = [];
  const spy = spyOn(statements, 'prepare').mockImplementation(function prepareAfterOther(query) {
    // Another opener tries to land its schema before every statement this one
    // prepares after the version probe, up to the read of the tables. A commit
    // and a new begin in that span leave a moment it can take.
    if (this !== other && span === 'between the reads' && !tries.includes('took the lock')) {
      tries.push(landSchema(other));
    }
    if (this !== other && span === 'before' && query.includes("name = 'schema_version'")) {
      span = 'between the reads';
    }
    if (this !== other && query.includes("name not like 'sqlite_%'")) {
      span = 'after';
    }
    return prepare.call(this, query);
  });
  try {
    const handle = await openSqlite(path);
    await handle.close();
    expect(tries).toContain('locked out');
    expect(tries).not.toContain('took the lock');
  } finally {
    spy.mockRestore();
    other.close();
  }
});

/**
 * Write a schema to the file as another opener would, if it can take the write
 * lock at once; whatever it cannot commit is rolled back.
 */
function landSchema(other: Database): 'locked out' | 'took the lock' {
  try {
    other.run('begin immediate');
  } catch {
    return 'locked out';
  }
  try {
    other.run('create table schema_version (version integer not null)');
    other.run('insert into schema_version (version) values (1)');
    other.run('commit');
  } catch {
    other.run('rollback');
  }
  return 'took the lock';
}

/** Open (and so create and migrate) the store at `path` in a separate process. */
const OPENER = `
  import { openSqlite } from '${new URL('client.ts', import.meta.url).pathname}';
  const handle = await openSqlite(process.argv[1]);
  await handle.close();
`;

test('processes racing to open one fresh file all open it', async () => {
  // A fresh install starts the daemon, MCP servers, and a CLI command at once.
  // One round is the race: seven of the eight openers lose it every time.
  const fresh = join(dir, 'data', 'race.sqlite');
  const openers = Array.from({ length: 8 }, () =>
    Bun.spawn(['bun', '-e', OPENER, fresh], { stderr: 'pipe', stdout: 'pipe' }),
  );
  const exits = await Promise.all(openers.map((opener) => opener.exited));
  for (const [index, code] of exits.entries()) {
    if (code !== 0) {
      throw new Error(await new Response(openers[index]?.stderr).text());
    }
  }
});

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
});

test.each([6, 7])(
  'upgrading version %i preserves node references, records, indexes, and handed-out log ids',
  async (version) => {
    const old = new Database(path, { create: true });
    old.run('PRAGMA foreign_keys = ON');
    for (const statement of [
      ...initStatements,
      ...groomingStatements,
      ...blockOwnerStatements,
      ...seedParkedStatements,
      ...projectPinnedStatements,
      ...projectRemoteStatements,
      ...(version === 7 ? taskQueuedStatements : []),
    ]) {
      old.run(statement);
    }
    old.run(
      `INSERT INTO schema_version (version, applied_at) VALUES (1, 't'), (2, 't'), (3, 't'), (4, 't'), (5, 't'), (6, 't')`,
    );
    if (version === 7) {
      old.run("INSERT INTO schema_version VALUES (7, 't')");
    }
    old.run(
      `INSERT INTO project (key, name, last_seq, created_at, updated_at) VALUES ('QUE', 'Queue', 11, 't', 't')`,
    );
    old.run(`INSERT INTO node (id, project_key, type, parent_id, seq, title, lifecycle, hold, rank, grooming, session, created_at, updated_at)
    VALUES ('QUE-1', 'QUE', 'initiative', NULL, 1, 'parent', NULL, NULL, NULL, NULL, NULL, 'c', 'u'),
           ('QUE-2', 'QUE', 'task', 'QUE-1', 2, 'first', 'todo', 'none', 1024, 'groomed', 'old', 'c', 'u'),
           ('QUE-3', 'QUE', 'task', 'QUE-1', 3, 'second', 'todo', 'none', 2048, 'not_groomed', NULL, 'c', 'u')`);
    old.run(`INSERT INTO dependency VALUES ('QUE-3', 'QUE-2')`);
    old.run(
      `INSERT INTO annotation (id, node_id, content, created_at) VALUES (7, 'QUE-2', 'kept', 'c')`,
    );
    old.run(
      `INSERT INTO artifact (id, project_key, seq, title, content, created_at, updated_at) VALUES ('QUE-a1', 'QUE', 1, 'artifact', 'body', 'c', 'u')`,
    );
    old.run(`INSERT INTO artifact_link VALUES ('QUE-a1', 'QUE-2')`);
    old.run(
      `INSERT INTO transition_log (id, node_id, kind, from_value, to_value, handles, at) VALUES (9, 'QUE-2', 'lifecycle', 'todo', 'in_progress', '{"session":"old"}', 'h')`,
    );
    old.run(`UPDATE sqlite_sequence SET seq = 17 WHERE name = 'annotation'`);
    old.run(`UPDATE sqlite_sequence SET seq = 19 WHERE name = 'transition_log'`);
    if (version === 6) {
      expect(() => old.run(`UPDATE node SET lifecycle = 'queued' WHERE id = 'QUE-2'`)).toThrow(
        'CHECK',
      );
    }
    expect(() =>
      old.run(`INSERT INTO transition_log (node_id, kind, at) VALUES ('QUE-2', 'assignment', 'h')`),
    ).toThrow('CHECK');
    old.close();

    const handle = await openSqlite(path);
    try {
      expect(handle.upgrade.applied).toEqual(
        version === 7
          ? [
              '0008_main_worker',
              '0009_device_tokens',
              '0010_pairing_requests',
              '0011_terminal_hold',
              '0012_host_secrets',
              '0013_runs',
            ]
          : [
              '0007_task_queued',
              '0008_main_worker',
              '0009_device_tokens',
              '0010_pairing_requests',
              '0011_terminal_hold',
              '0012_host_secrets',
              '0013_runs',
            ],
      );
      const store = createSqliteStore(handle.db);
      const exported = await store.export();
      expect(exported.nodes.find((n) => n.id === 'QUE-2')).toMatchObject({
        created_at: 'c',
        grooming: 'groomed',
        parent_id: 'QUE-1',
        rank: 1024,
        session: 'old',
        updated_at: 'u',
        worker_harness: null,
        worker_session: null,
      });
      expect(exported.edges).toEqual([{ depends_on_node_id: 'QUE-2', node_id: 'QUE-3' }]);
      expect(exported.annotations).toEqual([
        { content: 'kept', created_at: 'c', node_id: 'QUE-2' },
      ]);
      expect(exported.artifacts[0]?.links).toEqual(['QUE-2']);
      expect((await store.bodySections.readHistory('QUE-2'))[0]?.handles).toEqual({
        session: 'old',
      });
      expect((await sql`PRAGMA foreign_key_check`.execute(handle.db)).rows).toEqual([]);
      await sql`UPDATE node SET lifecycle = 'queued' WHERE id = 'QUE-2'`.execute(handle.db);
      expect(
        await refusal(
          sql`UPDATE node SET lifecycle = 'bogus' WHERE id = 'QUE-2'`.execute(handle.db),
        ),
      ).toContain('CHECK');
      const annotation = await sql<{
        id: number;
      }>`INSERT INTO annotation (node_id, content, created_at) VALUES ('QUE-2', 'next', 'c') RETURNING id`.execute(
        handle.db,
      );
      const transition = await sql<{
        id: number;
      }>`INSERT INTO transition_log (node_id, kind, at) VALUES ('QUE-2', 'assignment', 'h') RETURNING id`.execute(
        handle.db,
      );
      expect(annotation.rows[0]?.id).toBe(18);
      expect(transition.rows[0]?.id).toBe(20);
      const indexes = await sql<{
        name: string;
      }>`SELECT name FROM sqlite_schema WHERE type = 'index' AND name LIKE 'idx_%'`.execute(
        handle.db,
      );
      expect(indexes.rows.map((r) => r.name)).toEqual(
        expect.arrayContaining([
          'idx_node_parent',
          'idx_node_project',
          'idx_annotation_node',
          'idx_artifact_link_node',
          'idx_transition_node',
          'idx_transition_at',
          'idx_transition_project',
        ]),
      );
    } finally {
      await handle.close();
    }
  },
);

test('an approved poll on two SQLite connections mints once and rotates atomically', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mimir-token-race-'));
  const first = await openSqlite(join(directory, 'tokens.sqlite'));
  const second = await openSqlite(join(directory, 'tokens.sqlite'));
  try {
    const one = createTokenStore({ db: first.db, dialect: sqliteDialect });
    const two = createTokenStore({ db: second.db, dialect: sqliteDialect });
    const prior = await pairTestDevice(one, 'laptop');
    const request = await one.request('laptop');
    await one.approve(request.user_code);
    const results = await Promise.all([
      one.poll(request.poll_secret),
      two.poll(request.poll_secret),
    ]);
    const minted = results.flatMap((result) =>
      result.status === 'approved' ? [result.token] : [],
    );
    expect(minted).toHaveLength(1);
    expect(results.map((result) => result.status).toSorted()).toEqual(['approved', 'expired']);
    expect(await one.list()).toHaveLength(1);
    expect(await one.list({ all: true })).toHaveLength(2);
    expect(await two.verify(prior)).toBeNull();
    expect(await two.verify(minted[0] ?? '')).toBe('laptop');
  } finally {
    await first.close();
    await second.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test('0010_pairing_requests upgrades a version-9 store: pending codes go and device tokens stay', async () => {
  const old = new Database(path, { create: true });
  for (const statement of [
    ...initStatements,
    ...groomingStatements,
    ...blockOwnerStatements,
    ...seedParkedStatements,
    ...projectPinnedStatements,
    ...projectRemoteStatements,
    ...taskQueuedStatements,
    ...mainWorkerStatements,
    ...deviceTokensStatements,
  ]) {
    old.run(statement);
  }
  old.run(
    `INSERT INTO schema_version (version, applied_at) VALUES (1, 't'), (2, 't'), (3, 't'), (4, 't'), (5, 't'), (6, 't'), (7, 't'), (8, 't'), (9, 't')`,
  );
  old.run(
    `INSERT INTO pairing_codes (device, code_hash, created_at, expires_at) VALUES ('laptop', 'code', 'c', 'e')`,
  );
  old.run(
    `INSERT INTO device_tokens (id, device, token_hash, created_at) VALUES ('kept', 'laptop', 'token', 'c')`,
  );
  old.close();

  const handle = await openSqlite(path);
  try {
    expect(handle.upgrade).toEqual({
      applied: ['0010_pairing_requests', '0011_terminal_hold', '0012_host_secrets', '0013_runs'],
      from: 9,
      to: SCHEMA_VERSION,
    });
    const tables = await sql<{ name: string }>`
      select name from sqlite_schema where type = 'table' and name like 'pairing%' order by name
    `.execute(handle.db);
    expect(tables.rows).toEqual([{ name: 'pairing_requests' }]);
    expect(await handle.db.selectFrom('device_tokens').select(['id', 'device']).execute()).toEqual([
      { device: 'laptop', id: 'kept' },
    ]);
    const decided = {
      approved_at: 'a',
      created_at: 'c',
      denied_at: 'd',
      device: 'laptop',
      expires_at: 'e',
      id: 'both',
      poll_secret_hash: 'secret',
      user_code_hash: 'code',
    };
    expect(
      await refusal(handle.db.insertInto('pairing_requests').values(decided).execute()),
    ).toContain('CHECK');
  } finally {
    await handle.close();
  }
});

test('0011_terminal_hold upgrades a version-10 store: terminal tasks lose their hold, live holds stay', async () => {
  const old = new Database(path, { create: true });
  for (const statement of [
    ...initStatements,
    ...groomingStatements,
    ...blockOwnerStatements,
    ...seedParkedStatements,
    ...projectPinnedStatements,
    ...projectRemoteStatements,
    ...taskQueuedStatements,
    ...mainWorkerStatements,
    ...deviceTokensStatements,
    ...pairingRequestsStatements,
  ]) {
    old.run(statement);
  }
  old.run(
    `INSERT INTO schema_version (version, applied_at) VALUES (1, 't'), (2, 't'), (3, 't'), (4, 't'), (5, 't'), (6, 't'), (7, 't'), (8, 't'), (9, 't'), (10, 't')`,
  );
  old.run(
    `INSERT INTO project (key, name, created_at, updated_at) VALUES ('MMR', 'Mimir', 't', 't')`,
  );
  // The residue the previous binary's done and abandon left behind, beside live holds.
  const node = (
    seq: number,
    type: string,
    lifecycle: string | null,
    hold: string | null,
    reason: string | null,
    owner: string | null,
  ) => {
    old.run(
      `INSERT INTO node (id, project_key, type, seq, title, lifecycle, hold, hold_reason, block_owner, created_at, updated_at)
       VALUES ('MMR-${String(seq)}', 'MMR', '${type}', ${String(seq)}, 't', ${sqlLiteral(lifecycle)}, ${sqlLiteral(hold)}, ${sqlLiteral(reason)}, ${sqlLiteral(owner)}, 't', 'u')`,
    );
  };
  node(1, 'initiative', null, null, null, null);
  node(2, 'task', 'done', 'blocked', 'vendor', 'others');
  node(3, 'task', 'abandoned', 'blocked', 'stuck', 'you');
  node(4, 'task', 'abandoned', 'parked', 'later', null);
  node(5, 'task', 'in_progress', 'blocked', 'vendor', 'you');
  node(6, 'task', 'todo', 'parked', 'later', null);
  node(7, 'task', 'done', 'none', null, null);
  node(8, 'task', 'done', 'none', 'stray', 'you');
  node(9, 'task', 'done', 'parked', null, null);
  old.close();

  const handle = await openSqlite(path);
  try {
    expect(handle.upgrade).toEqual({
      applied: ['0011_terminal_hold', '0012_host_secrets', '0013_runs'],
      from: 10,
      to: SCHEMA_VERSION,
    });
    const rows = await sql<{
      id: string;
      hold: string | null;
      hold_reason: string | null;
      block_owner: string | null;
      updated_at: string;
    }>`
      select id, hold, hold_reason, block_owner, updated_at from node order by seq
    `.execute(handle.db);
    expect(rows.rows).toEqual([
      { block_owner: null, hold: null, hold_reason: null, id: 'MMR-1', updated_at: 'u' },
      { block_owner: null, hold: 'none', hold_reason: null, id: 'MMR-2', updated_at: 'u' },
      { block_owner: null, hold: 'none', hold_reason: null, id: 'MMR-3', updated_at: 'u' },
      { block_owner: null, hold: 'none', hold_reason: null, id: 'MMR-4', updated_at: 'u' },
      { block_owner: 'you', hold: 'blocked', hold_reason: 'vendor', id: 'MMR-5', updated_at: 'u' },
      { block_owner: null, hold: 'parked', hold_reason: 'later', id: 'MMR-6', updated_at: 'u' },
      { block_owner: null, hold: 'none', hold_reason: null, id: 'MMR-7', updated_at: 'u' },
      { block_owner: null, hold: 'none', hold_reason: null, id: 'MMR-8', updated_at: 'u' },
      { block_owner: null, hold: 'none', hold_reason: null, id: 'MMR-9', updated_at: 'u' },
    ]);
  } finally {
    await handle.close();
  }
});

test('0012_host_secrets upgrades a version-11 store: an empty host_secrets table, device tokens stay', async () => {
  const old = new Database(path, { create: true });
  for (const statement of [
    ...initStatements,
    ...groomingStatements,
    ...blockOwnerStatements,
    ...seedParkedStatements,
    ...projectPinnedStatements,
    ...projectRemoteStatements,
    ...taskQueuedStatements,
    ...mainWorkerStatements,
    ...deviceTokensStatements,
    ...pairingRequestsStatements,
    ...terminalHoldStatements,
  ]) {
    old.run(statement);
  }
  old.run(
    `INSERT INTO schema_version (version, applied_at) VALUES (1, 't'), (2, 't'), (3, 't'), (4, 't'), (5, 't'), (6, 't'), (7, 't'), (8, 't'), (9, 't'), (10, 't'), (11, 't')`,
  );
  old.run(
    `INSERT INTO device_tokens (id, device, token_hash, created_at) VALUES ('kept', 'laptop', 'token', 'c')`,
  );
  old.close();

  const handle = await openSqlite(path);
  try {
    expect(handle.upgrade).toEqual({
      applied: ['0012_host_secrets', '0013_runs'],
      from: 11,
      to: SCHEMA_VERSION,
    });
    expect(await handle.db.selectFrom('host_secrets').selectAll().execute()).toEqual([]);
    expect(await handle.db.selectFrom('device_tokens').select(['id', 'device']).execute()).toEqual([
      { device: 'laptop', id: 'kept' },
    ]);
    const row = { ciphertext: 'v1.a.b', created_at: 'c', name: 't3.oauth', updated_at: 'u' };
    await handle.db.insertInto('host_secrets').values(row).execute();
    expect(await refusal(handle.db.insertInto('host_secrets').values(row).execute())).toContain(
      'UNIQUE',
    );
    expect(
      await refusal(
        sql`INSERT INTO host_secrets (name, ciphertext, created_at, updated_at) VALUES ('n', X'00', 'c', 'u')`.execute(
          handle.db,
        ),
      ),
    ).toContain('cannot store BLOB value in TEXT column');
  } finally {
    await handle.close();
  }
});

test('0013_runs upgrades a version-12 store: an empty runs table that admits one running row', async () => {
  const old = new Database(path, { create: true });
  for (const statement of [
    ...initStatements,
    ...groomingStatements,
    ...blockOwnerStatements,
    ...seedParkedStatements,
    ...projectPinnedStatements,
    ...projectRemoteStatements,
    ...taskQueuedStatements,
    ...mainWorkerStatements,
    ...deviceTokensStatements,
    ...pairingRequestsStatements,
    ...terminalHoldStatements,
    ...hostSecretsStatements,
  ]) {
    old.run(statement);
  }
  old.run(
    `INSERT INTO schema_version (version, applied_at) VALUES (1, 't'), (2, 't'), (3, 't'), (4, 't'), (5, 't'), (6, 't'), (7, 't'), (8, 't'), (9, 't'), (10, 't'), (11, 't'), (12, 't')`,
  );
  old.run(
    `INSERT INTO host_secrets (name, ciphertext, created_at, updated_at) VALUES ('kept', 'v1.a.b', 'c', 'u')`,
  );
  old.close();

  const handle = await openSqlite(path);
  try {
    expect(handle.upgrade).toEqual({ applied: ['0013_runs'], from: 12, to: SCHEMA_VERSION });
    expect(await handle.db.selectFrom('runs').selectAll().execute()).toEqual([]);
    expect(await handle.db.selectFrom('host_secrets').select('name').execute()).toEqual([
      { name: 'kept' },
    ]);
    const row = {
      heartbeat_at: 'h',
      id: 'r1',
      kind: 'groom',
      model: 'm',
      project: 'MMR',
      reserved_tokens: 1,
      runner: 'a',
      started_at: 's',
      state: 'running',
      task: 'MMR-1',
      trigger: 'console',
    } as const;
    await handle.db.insertInto('runs').values(row).execute();
    expect(
      await refusal(
        handle.db
          .insertInto('runs')
          .values({ ...row, id: 'r2' })
          .execute(),
      ),
    ).toContain('UNIQUE');
    expect(
      await refusal(
        handle.db
          .insertInto('runs')
          .values({ ...row, id: 'r3', kind: 'x' as 'groom', state: 'succeeded' })
          .execute(),
      ),
    ).toContain('CHECK');
    await handle.db
      .insertInto('runs')
      .values({ ...row, id: 'r4', state: 'failed' })
      .execute();
  } finally {
    await handle.close();
  }
});

/**
 * A store owner's helper process (the host's `mimir-host`) opens the owner's
 * store as it finds it: it neither creates the file nor moves its schema, so
 * every refusal leaves the bytes on disk exactly as they were.
 */
test('an existing-only open refuses a missing file and creates nothing', async () => {
  const message = await refusal(openExistingSqlite(path));
  expect(message).toContain(`no store at ${path}`);
  expect(existsSync(path)).toBe(false);
});

test('an existing-only open refuses an older or newer schema without writing', async () => {
  for (const [label, adjust] of [
    [
      'older',
      (handle: Awaited<ReturnType<typeof openSqlite>>) =>
        handle.db.deleteFrom('schema_version').where('version', '=', SCHEMA_VERSION).execute(),
    ],
    [
      'newer',
      (handle: Awaited<ReturnType<typeof openSqlite>>) =>
        handle.db
          .insertInto('schema_version')
          .values({ applied_at: '2099-01-01T00:00:00.000Z', version: SCHEMA_VERSION + 1 })
          .execute(),
    ],
  ] as const) {
    rmSync(join(dir, 'data'), { force: true, recursive: true });
    mkdirSync(join(dir, 'data'));
    const handle = await openSqlite(path);
    await adjust(handle);
    await handle.close();
    const before = readFileSync(path);

    const message = await refusal(openExistingSqlite(path));
    expect(message, label).toContain('the SQLite store schema is version');
    expect(readFileSync(path).equals(before), label).toBe(true);
  }
});

test('an existing-only open names the store owner as the remedy for an older schema', async () => {
  const handle = await openSqlite(path);
  await handle.db.deleteFrom('schema_version').where('version', '=', SCHEMA_VERSION).execute();
  await handle.close();

  let hint: string | undefined;
  try {
    await openExistingSqlite(path);
  } catch (error) {
    hint = (error as { hint?: string }).hint;
  }
  expect(hint).toContain('migrates the store when it starts');
});

test('an existing-only open reads a current store and applies nothing', async () => {
  const first = await openSqlite(path);
  await createProject(createSqliteStore(first.db), {
    description: null,
    key: 'MMR',
    name: 'Mimir',
  });
  await first.close();

  const second = await openExistingSqlite(path);
  try {
    expect(second.upgrade).toEqual({ applied: [], from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    const projects = await createSqliteStore(second.db).loadProjects();
    expect(projects.map((project) => project.key)).toEqual(['MMR']);
  } finally {
    await second.close();
  }
});
