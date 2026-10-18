import { expect, test } from 'bun:test';

import { Kysely, sql } from 'kysely';

import { MimirError } from '../errors';
import { assertSchemaCurrent, readSchemaVersion, SCHEMA_VERSION, upgradeSchema } from './index';
import type { DB } from './index';
import { statements as initStatements } from './migrations/0001-init';
import { statements as groomingStatements } from './migrations/0002-grooming';
import { statements as blockOwnerStatements } from './migrations/0003-block-owner';
import { statements as seedParkedStatements } from './migrations/0004-seed-parked';
import { statements as projectPinnedStatements } from './migrations/0005-project-pinned';
import { createPgliteDialect } from './pglite';
import { createEmptyPglite } from './testing';

async function freshDb(): Promise<Kysely<DB>> {
  return new Kysely<DB>({ dialect: createPgliteDialect(await createEmptyPglite()) });
}

async function refusalOf(action: Promise<unknown>): Promise<MimirError> {
  const error = await action.then(
    () => new Error('expected a refusal'),
    (reason: unknown) => reason,
  );
  if (!(error instanceof MimirError)) {
    throw error instanceof Error ? error : new Error(String(error));
  }
  return error;
}

test('a fresh database carries no schema version and refuses every read', async () => {
  const db = await freshDb();
  try {
    expect(await readSchemaVersion(db)).toBeNull();
    const refusal = await refusalOf(assertSchemaCurrent(db));
    expect(refusal.message).toBe('the Postgres store has no schema');
    expect(refusal.hint).toBe("run 'mimir store upgrade' to create it");
  } finally {
    await db.destroy();
  }
});

test('an upgrade names the migrations it applied and lands the current version', async () => {
  const db = await freshDb();
  try {
    expect(await upgradeSchema(db)).toEqual({
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
    expect(await readSchemaVersion(db)).toBe(SCHEMA_VERSION);
    await assertSchemaCurrent(db);
    // Idempotent: a second upgrade of a current store applies nothing.
    expect(await upgradeSchema(db)).toEqual({
      applied: [],
      from: SCHEMA_VERSION,
      to: SCHEMA_VERSION,
    });
  } finally {
    await db.destroy();
  }
});

test('0002_grooming upgrades a version-1 store: tasks not_groomed, containers NULL, bogus values rejected', async () => {
  const db = await freshDb();
  try {
    // The store as the previous binary left it: only 0001, with live rows.
    for (const statement of initStatements) {
      await sql.raw(statement).execute(db);
    }
    await sql`insert into schema_version (version, applied_at) values (1, '2026-09-01T00:00:00.000Z')`.execute(
      db,
    );
    await sql`insert into project (key, name, created_at, updated_at) values ('MMR', 'Mimir', 't', 't')`.execute(
      db,
    );
    await sql`
      insert into node (id, project_key, type, seq, title, lifecycle, hold, created_at, updated_at)
      values ('MMR-1', 'MMR', 'initiative', 1, 't', null, null, 't', 't'),
             ('MMR-2', 'MMR', 'phase', 2, 't', null, null, 't', 't'),
             ('MMR-3', 'MMR', 'task', 3, 't', 'todo', 'none', 't', 't')
    `.execute(db);

    expect(await upgradeSchema(db)).toEqual({
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
    `.execute(db);
    expect(rows.rows).toEqual([
      { grooming: null, id: 'MMR-1' },
      { grooming: null, id: 'MMR-2' },
      { grooming: 'not_groomed', id: 'MMR-3' },
    ]);
    const rejection = await sql`update node set grooming = 'bogus' where id = 'MMR-3'`
      .execute(db)
      .then(
        () => 'accepted',
        (reason: unknown) => String(reason),
      );
    expect(rejection).toContain('node_grooming_check');
  } finally {
    await db.destroy();
  }
});

test('0003_block_owner upgrades a version-2 store: blocked tasks get an owner by their upstream, everything else NULL, bogus values rejected', async () => {
  const db = await freshDb();
  try {
    // The store as the previous binary left it: 0001 + 0002, with live rows.
    for (const statement of [...initStatements, ...groomingStatements]) {
      await sql.raw(statement).execute(db);
    }
    await sql`insert into schema_version (version, applied_at) values (1, '2026-09-01T00:00:00.000Z'), (2, '2026-09-02T00:00:00.000Z')`.execute(
      db,
    );
    await sql`insert into project (key, name, created_at, updated_at) values ('MMR', 'Mimir', 't', 't')`.execute(
      db,
    );
    await sql`
      insert into node (id, project_key, type, seq, title, lifecycle, hold, upstream, created_at, updated_at)
      values ('MMR-1', 'MMR', 'initiative', 1, 't', null, null, null, 't', 't'),
             ('MMR-2', 'MMR', 'task', 2, 't', 'todo', 'blocked', 'OPS-s4', 't', 't'),
             ('MMR-3', 'MMR', 'task', 3, 't', 'todo', 'blocked', null, 't', 't'),
             ('MMR-4', 'MMR', 'task', 4, 't', 'todo', 'parked', 'OPS-s5', 't', 't'),
             ('MMR-5', 'MMR', 'task', 5, 't', 'todo', 'none', 'OPS-s6', 't', 't')
    `.execute(db);

    expect(await upgradeSchema(db)).toEqual({
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
    `.execute(db);
    expect(rows.rows).toEqual([
      { block_owner: null, id: 'MMR-1' },
      { block_owner: 'others', id: 'MMR-2' },
      { block_owner: 'you', id: 'MMR-3' },
      { block_owner: null, id: 'MMR-4' },
      { block_owner: null, id: 'MMR-5' },
    ]);
    const rejection = await sql`update node set block_owner = 'bogus' where id = 'MMR-3'`
      .execute(db)
      .then(
        () => 'accepted',
        (reason: unknown) => String(reason),
      );
    expect(rejection).toContain('node_block_owner_check');
  } finally {
    await db.destroy();
  }
});

test('0004_seed_parked upgrades a version-3 store: seeds keep their lifecycle, parked is admitted, bogus values rejected', async () => {
  const db = await freshDb();
  try {
    // The store as the previous binary left it: 0001–0003, with a seed.
    for (const statement of [...initStatements, ...groomingStatements, ...blockOwnerStatements]) {
      await sql.raw(statement).execute(db);
    }
    await sql`insert into schema_version (version, applied_at) values (1, 't'), (2, 't'), (3, 't')`.execute(
      db,
    );
    await sql`insert into project (key, name, created_at, updated_at) values ('MMR', 'Mimir', 't', 't')`.execute(
      db,
    );
    await sql`
      insert into seed (id, project_key, seq, title, kind, lifecycle, created_at, updated_at)
      values ('MMR-s1', 'MMR', 1, 't', 'idea', 'new', 't', 't')
    `.execute(db);
    // The previous schema refuses the new word, so the upgrade is what admits it.
    const before = await sql`update seed set lifecycle = 'parked' where id = 'MMR-s1'`
      .execute(db)
      .then(
        () => 'accepted',
        (reason: unknown) => String(reason),
      );
    expect(before).toContain('seed_lifecycle_check');

    expect(await upgradeSchema(db)).toEqual({
      applied: ['0004_seed_parked', '0005_project_pinned', '0006_project_remote'],
      from: 3,
      to: SCHEMA_VERSION,
    });
    await sql`update seed set lifecycle = 'parked' where id = 'MMR-s1'`.execute(db);
    const rows = await sql<{ lifecycle: string }>`select lifecycle from seed`.execute(db);
    expect(rows.rows).toEqual([{ lifecycle: 'parked' }]);
    const rejection = await sql`update seed set lifecycle = 'bogus' where id = 'MMR-s1'`
      .execute(db)
      .then(
        () => 'accepted',
        (reason: unknown) => String(reason),
      );
    expect(rejection).toContain('seed_lifecycle_check');
  } finally {
    await db.destroy();
  }
});

test('0005_project_pinned upgrades a version-4 store: projects keep their data and read unpinned, NULL is rejected', async () => {
  const db = await freshDb();
  try {
    // The store as the previous binary left it: 0001–0004, with two projects.
    for (const statement of [
      ...initStatements,
      ...groomingStatements,
      ...blockOwnerStatements,
      ...seedParkedStatements,
    ]) {
      await sql.raw(statement).execute(db);
    }
    await sql`insert into schema_version (version, applied_at) values (1, 't'), (2, 't'), (3, 't'), (4, 't')`.execute(
      db,
    );
    await sql`
      insert into project (key, name, description, last_seq, created_at, updated_at)
      values ('MMR', 'Mimir', 'the store', 7, 'c', 'u'), ('OPS', 'Ops', null, 0, 'c', 'u')
    `.execute(db);

    expect(await upgradeSchema(db)).toEqual({
      applied: ['0005_project_pinned', '0006_project_remote'],
      from: 4,
      to: SCHEMA_VERSION,
    });
    const rows = await sql<{
      key: string;
      description: string | null;
      last_seq: number;
      pinned: boolean;
    }>`select key, description, last_seq, pinned from project order by key`.execute(db);
    expect(rows.rows).toEqual([
      { description: 'the store', key: 'MMR', last_seq: 7, pinned: false },
      { description: null, key: 'OPS', last_seq: 0, pinned: false },
    ]);
    await sql`update project set pinned = true where key = 'MMR'`.execute(db);
    const rejection = await sql`update project set pinned = null where key = 'MMR'`
      .execute(db)
      .then(
        () => 'accepted',
        (reason: unknown) => String(reason),
      );
    expect(rejection).toContain('pinned');
  } finally {
    await db.destroy();
  }
});

test('0006_project_remote upgrades a version-5 store: projects keep their data and read with no remote', async () => {
  const db = await freshDb();
  try {
    for (const statement of [
      ...initStatements,
      ...groomingStatements,
      ...blockOwnerStatements,
      ...seedParkedStatements,
      ...projectPinnedStatements,
    ]) {
      await sql.raw(statement).execute(db);
    }
    await sql`insert into schema_version (version, applied_at) values (1, 't'), (2, 't'), (3, 't'), (4, 't'), (5, 't')`.execute(
      db,
    );
    await sql`
      insert into project (key, name, description, last_seq, pinned, created_at, updated_at)
      values ('MMR', 'Mimir', 'the store', 7, true, 'c', 'u'), ('OPS', 'Ops', null, 0, false, 'c', 'u')
    `.execute(db);

    expect(await upgradeSchema(db)).toEqual({
      applied: ['0006_project_remote'],
      from: 5,
      to: SCHEMA_VERSION,
    });
    const rows = await sql<{
      key: string;
      description: string | null;
      last_seq: number;
      pinned: boolean;
      remote: string | null;
    }>`select key, description, last_seq, pinned, remote from project order by key`.execute(db);
    expect(rows.rows).toEqual([
      {
        description: 'the store',
        key: 'MMR',
        last_seq: 7,
        pinned: true,
        remote: null,
      },
      {
        description: null,
        key: 'OPS',
        last_seq: 0,
        pinned: false,
        remote: null,
      },
    ]);
  } finally {
    await db.destroy();
  }
});

test('a schema newer than the binary is refused, and never downgraded', async () => {
  const db = await freshDb();
  try {
    await upgradeSchema(db);
    await db
      .insertInto('schema_version')
      .values({ applied_at: '2026-09-01T00:00:00.000Z', version: SCHEMA_VERSION + 1 })
      .execute();
    expect((await refusalOf(assertSchemaCurrent(db))).message).toContain(
      `is version ${String(SCHEMA_VERSION + 1)}`,
    );
    expect((await refusalOf(upgradeSchema(db))).hint).toBe(
      'upgrade the binary; a newer schema is never downgraded',
    );
  } finally {
    await db.destroy();
  }
});

test('a schema older than the binary is refused, and points at the explicit upgrade', async () => {
  const db = await freshDb();
  try {
    await upgradeSchema(db);
    await db.deleteFrom('schema_version').execute();
    await db
      .insertInto('schema_version')
      .values({ applied_at: '2026-09-01T00:00:00.000Z', version: SCHEMA_VERSION - 1 })
      .execute();
    const refusal = await refusalOf(assertSchemaCurrent(db));
    expect(refusal.message).toContain(`this binary needs version ${String(SCHEMA_VERSION)}`);
    expect(refusal.hint).toContain('mimir store upgrade');
  } finally {
    await db.destroy();
  }
});

test('an upgrade skips a migration whose version is already recorded', async () => {
  const db = await freshDb();
  try {
    // The state the LOSER of an upgrade race sees when it re-reads inside the
    // advisory lock: the version is already there, so the migration must not
    // run a second time. (The race itself belongs to the real-Postgres lane —
    // PGlite is one session, so two connections cannot contend here.)
    await sql`create table schema_version (version integer primary key, applied_at text not null)`.execute(
      db,
    );
    await db
      .insertInto('schema_version')
      .values({ applied_at: '2026-09-01T00:00:00.000Z', version: SCHEMA_VERSION })
      .execute();
    expect(await upgradeSchema(db)).toEqual({
      applied: [],
      from: SCHEMA_VERSION,
      to: SCHEMA_VERSION,
    });
    // The migration's own tables were never created, so nothing re-ran.
    const present = await sql<{
      present: string | null;
    }>`select to_regclass('project')::text as present`.execute(db);
    expect(present.rows[0]?.present).toBeNull();
  } finally {
    await db.destroy();
  }
});

test('seed_history.kind is constrained to the transition-kind vocabulary', async () => {
  const db = await freshDb();
  try {
    await upgradeSchema(db);
    await db
      .insertInto('project')
      .values({
        created_at: '2026-09-01T00:00:00.000Z',
        key: 'MMR',
        name: 'Mimir',
        updated_at: '2026-09-01T00:00:00.000Z',
      })
      .execute();
    await db
      .insertInto('seed')
      .values({
        created_at: '2026-09-01T00:00:00.000Z',
        id: 'MMR-s1',
        kind: 'idea',
        lifecycle: 'new',
        project_key: 'MMR',
        seq: 1,
        title: 'A seed',
        updated_at: '2026-09-01T00:00:00.000Z',
      })
      .execute();
    // A hand-written insert, not the app's typed writer: exercises the
    // database CHECK directly, the way an older or foreign client could.
    expect(
      sql`insert into seed_history (seed_id, kind, at) values ('MMR-s1', 'not-a-real-kind', '2026-09-01T00:00:00.000Z')`.execute(
        db,
      ),
    ).rejects.toThrow(/violates check constraint/);
  } finally {
    await db.destroy();
  }
});

test('migration progress reports committed steps even when a later migration fails', async () => {
  const db = await freshDb();
  try {
    for (const statement of initStatements) {
      await sql.raw(statement).execute(db);
    }
    await sql`INSERT INTO schema_version (version, applied_at) VALUES (1, now())`.execute(db);
    await sql`ALTER TABLE node ADD COLUMN block_owner text`.execute(db);
    const applied: string[] = [];
    let refusal: unknown;
    try {
      await upgradeSchema(db, (name) => applied.push(name));
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(Error);
    expect(applied).toEqual(['0002_grooming']);
    expect(await readSchemaVersion(db)).toBe(2);
  } finally {
    await db.destroy();
  }
});
