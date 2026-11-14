import { beforeAll, expect, test } from 'bun:test';

import { Kysely, sql } from 'kysely';

import { MimirError } from '../errors';
import { assertSchemaCurrent, readSchemaVersion, SCHEMA_VERSION, upgradeSchema } from './index';
import type { DB } from './index';
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
import { statements as runsStatements } from './migrations/0013-runs';
import { createPgliteDialect } from './pglite';
import { bootEmptyPglite, createEmptyPglite } from './testing';

beforeAll(bootEmptyPglite);

async function freshDb(): Promise<Kysely<DB>> {
  return new Kysely<DB>({ dialect: createPgliteDialect(await createEmptyPglite()) });
}

/** The rejection text of an awaited action, or 'accepted'. */
async function rejectionOf(action: Promise<unknown>): Promise<string> {
  try {
    await action;
    return 'accepted';
  } catch (error) {
    return String(error);
  }
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
    expect(refusal.hint).toBe('start the host once; it creates the store when it starts');
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
        '0007_task_queued',
        '0008_main_worker',
        '0009_device_tokens',
        '0010_pairing_requests',
        '0011_terminal_hold',
        '0012_host_secrets',
        '0013_runs',
        '0014_task_staged',
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
    expect(refusal.hint).toContain('restart the host');
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
      sql`insert into seed_history (seed_id, kind, at) values ('MMR-s1', 'assignment', '2026-09-01T00:00:00.000Z')`.execute(
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

test('0013_runs upgrades a version-12 store: an empty runs table that admits one running row', async () => {
  const db = await freshDb();
  try {
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
      await sql.raw(statement).execute(db);
    }
    await sql`insert into schema_version (version, applied_at) values (1, 't'), (2, 't'), (3, 't'), (4, 't'), (5, 't'), (6, 't'), (7, 't'), (8, 't'), (9, 't'), (10, 't'), (11, 't'), (12, 't')`.execute(
      db,
    );

    expect(await upgradeSchema(db)).toEqual({
      applied: ['0013_runs', '0014_task_staged'],
      from: 12,
      to: SCHEMA_VERSION,
    });
    expect(await db.selectFrom('runs').selectAll().execute()).toEqual([]);
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
    await db.insertInto('runs').values(row).execute();
    expect(
      await rejectionOf(
        db
          .insertInto('runs')
          .values({ ...row, id: 'r2' })
          .execute(),
      ),
    ).toContain('duplicate key');
    expect(
      await rejectionOf(
        db
          .insertInto('runs')
          .values({ ...row, id: 'r3', kind: 'x' as 'groom', state: 'failed' })
          .execute(),
      ),
    ).toContain('check constraint');
    await db
      .insertInto('runs')
      .values({ ...row, id: 'r4', state: 'failed' })
      .execute();
  } finally {
    await db.destroy();
  }
});

test('0014_task_staged upgrades a version-13 store: nodes survive, staged is admitted, junk is refused', async () => {
  const db = await freshDb();
  try {
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
      ...runsStatements,
    ]) {
      await sql.raw(statement).execute(db);
    }
    await sql`insert into schema_version (version, applied_at) values (1, 't'), (2, 't'), (3, 't'), (4, 't'), (5, 't'), (6, 't'), (7, 't'), (8, 't'), (9, 't'), (10, 't'), (11, 't'), (12, 't'), (13, 't')`.execute(
      db,
    );
    await sql`insert into project (key, name, created_at, updated_at) values ('MMR', 'Mimir', 't', 't')`.execute(
      db,
    );
    await sql`insert into node (id, project_key, type, seq, title, lifecycle, hold, created_at, updated_at) values ('MMR-1', 'MMR', 'task', 1, 'one', 'under_review', 'none', 't', 't')`.execute(
      db,
    );

    expect(await upgradeSchema(db)).toEqual({
      applied: ['0014_task_staged'],
      from: 13,
      to: SCHEMA_VERSION,
    });
    expect(await sql`select id, lifecycle from node`.execute(db)).toMatchObject({
      rows: [{ id: 'MMR-1', lifecycle: 'under_review' }],
    });
    await sql`update node set lifecycle = 'staged' where id = 'MMR-1'`.execute(db);
    expect(await rejectionOf(sql`update node set lifecycle = 'merged'`.execute(db))).toContain(
      'check constraint',
    );
  } finally {
    await db.destroy();
  }
});
