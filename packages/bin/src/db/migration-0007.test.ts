import { expect, test } from 'bun:test';

import { Migrator, sql } from 'kysely';
import type { Migration, MigrationProvider } from 'kysely';

import { createDb } from './client';
import { migrations } from './migrations';
import { expectReject } from './testing';

/**
 * MMR-121 / ADR 0015 migration 0007 — generalizing `transition_log` from
 * node-keyed to entity-keyed is a full table rebuild (SQLite can't make a column
 * nullable or add a CHECK in place). These pin what a rebuild can silently
 * break: that existing (all node-keyed) rows survive verbatim, that the new XOR
 * constraint accepts exactly one of node_id/project_id, and that a project-keyed
 * `archive` row is now legal.
 */

class MapProvider implements MigrationProvider {
  private readonly set: Record<string, Migration>;
  constructor(set: Record<string, Migration>) {
    this.set = set;
  }
  getMigrations(): Promise<Record<string, Migration>> {
    return Promise.resolve(this.set);
  }
}

/** Apply every migration strictly before 0007 — the pre-rebuild baseline. */
async function dbAt0006() {
  const db = createDb(':memory:');
  const migrator = new Migrator({ db, provider: new MapProvider(migrations) });
  const { error } = await migrator.migrateTo('0006_lifecycle_under_review');
  if (error !== undefined) {
    throw error;
  }
  return db;
}

function apply0007(db: ReturnType<typeof createDb>) {
  const migrator = new Migrator({ db, provider: new MapProvider(migrations) });
  return migrator.migrateToLatest();
}

test('0007 preserves existing node-keyed transition rows verbatim', async () => {
  const db = await dbAt0006();
  try {
    await sql`INSERT INTO project (id, key, name) VALUES (1, 'MMR', 'm')`.execute(db);
    await sql`INSERT INTO node (id, project_id, type, seq, title, lifecycle, hold)
              VALUES (11, 1, 'task', 1, 't', 'in_progress', 'none')`.execute(db);
    await sql`INSERT INTO transition_log (id, node_id, kind, from_value, to_value, at, reason)
              VALUES (1, 11, 'lifecycle', 'todo', 'in_progress', '2026-01-01T00:00:00.000Z', 'started')`.execute(
      db,
    );
    await sql`INSERT INTO transition_log (id, node_id, kind, from_value, to_value, reason)
              VALUES (2, 11, 'move', NULL, NULL, NULL)`.execute(db);

    const { error } = await apply0007(db);
    expect(error).toBeUndefined();

    const rows = await db.selectFrom('transition_log').selectAll().orderBy('id', 'asc').execute();
    expect(rows).toHaveLength(2);
    // Row 1 survives verbatim, with project_id defaulted to NULL.
    expect(rows[0]).toMatchObject({
      at: '2026-01-01T00:00:00.000Z',
      from_value: 'todo',
      kind: 'lifecycle',
      node_id: 11,
      project_id: null,
      reason: 'started',
      to_value: 'in_progress',
    });
    expect(rows[1]?.node_id).toBe(11);
    expect(rows[1]?.project_id).toBeNull();

    // The new project_id index exists (SQLite master catalog).
    const idx = await sql<{
      name: string;
    }>`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_transition_project'`.execute(
      db,
    );
    expect(idx.rows).toHaveLength(1);
  } finally {
    await db.destroy();
  }
});

test('0007 XOR: exactly one of node_id / project_id, and archive rows are legal', async () => {
  const db = await dbAt0006();
  try {
    await sql`INSERT INTO project (id, key, name) VALUES (1, 'MMR', 'm')`.execute(db);
    await sql`INSERT INTO node (id, project_id, type, seq, title, lifecycle, hold)
              VALUES (11, 1, 'task', 1, 't', 'todo', 'none')`.execute(db);
    const { error } = await apply0007(db);
    expect(error).toBeUndefined();

    // A project-keyed archive row is accepted.
    await sql`INSERT INTO transition_log (node_id, project_id, kind, from_value, to_value)
              VALUES (NULL, 1, 'archive', 'active', 'archived')`.execute(db);
    expect(
      (await db.selectFrom('transition_log').selectAll().where('kind', '=', 'archive').execute())
        .length,
    ).toBe(1);

    // Neither set → rejected.
    await expectReject(() =>
      sql`INSERT INTO transition_log (node_id, project_id, kind) VALUES (NULL, NULL, 'lifecycle')`.execute(
        db,
      ),
    );
    // Both set → rejected.
    await expectReject(() =>
      sql`INSERT INTO transition_log (node_id, project_id, kind) VALUES (11, 1, 'lifecycle')`.execute(
        db,
      ),
    );
  } finally {
    await db.destroy();
  }
});
