import { expect, test } from 'bun:test';

import { sql } from 'kysely';

import { createTestDb, expectReject } from './testing';

test('migration creates every table', async () => {
  const db = await createTestDb();
  try {
    const rows = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'kysely_%' AND name NOT LIKE 'sqlite_%'
    `.execute(db);
    expect(rows.rows.map((r) => r.name).toSorted()).toEqual([
      'annotation',
      'artifact',
      'artifact_link',
      'dependency',
      'node',
      'project',
      'tag',
      'transition_log',
    ]);
  } finally {
    await db.destroy();
  }
});

test('project.key CHECK rejects a non-uppercase / wrong-length key', async () => {
  const db = await createTestDb();
  try {
    await expectReject(() =>
      db.insertInto('project').values({ key: 'mmr', name: 'lowercase' }).execute(),
    );
    await expectReject(() =>
      db.insertInto('project').values({ key: 'TOOLONG', name: 'five+' }).execute(),
    );
    // A valid key inserts and defaults last_seq + timestamps.
    const p = await db
      .insertInto('project')
      .values({ key: 'MMR', name: 'Mimir' })
      .returningAll()
      .executeTakeFirstOrThrow();
    expect(p.last_seq).toBe(0);
    expect(p.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  } finally {
    await db.destroy();
  }
});

test('node type-integrity CHECKs make illegal rows unrepresentable', async () => {
  const db = await createTestDb();
  try {
    const p = await db
      .insertInto('project')
      .values({ key: 'MMR', name: 'Mimir' })
      .returning('id')
      .executeTakeFirstOrThrow();

    // initiative carrying task-only status → rejected
    await expectReject(() =>
      db
        .insertInto('node')
        .values({ project_id: p.id, type: 'initiative', seq: 1, title: 'i', lifecycle: 'todo' })
        .execute(),
    );

    // task missing the hold axis → rejected (every task has both axes)
    await expectReject(() =>
      db
        .insertInto('node')
        .values({ project_id: p.id, type: 'task', seq: 2, title: 't', lifecycle: 'todo' })
        .execute(),
    );

    // non-phase carrying a target → rejected
    await expectReject(() =>
      db
        .insertInto('node')
        .values({ project_id: p.id, type: 'initiative', seq: 3, title: 'i', target: 'x' })
        .execute(),
    );

    // a well-formed task is accepted
    await db
      .insertInto('node')
      .values({
        project_id: p.id,
        type: 'task',
        seq: 4,
        title: 'ok',
        lifecycle: 'todo',
        hold: 'none',
      })
      .execute();
    const count = await db
      .selectFrom('node')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    expect(count.n).toBe(1);
  } finally {
    await db.destroy();
  }
});

test('(project_id, seq) is unique', async () => {
  const db = await createTestDb();
  try {
    const p = await db
      .insertInto('project')
      .values({ key: 'MMR', name: 'Mimir' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('node')
      .values({ project_id: p.id, type: 'phase', seq: 1, title: 'p1' })
      .execute();
    await expectReject(() =>
      db
        .insertInto('node')
        .values({ project_id: p.id, type: 'phase', seq: 1, title: 'dup' })
        .execute(),
    );
  } finally {
    await db.destroy();
  }
});
