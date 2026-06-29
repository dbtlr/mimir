import { expect, test } from 'bun:test';

import { Migrator, sql } from 'kysely';
import type { Migration, MigrationProvider } from 'kysely';

import { createDb } from './client';
import { migrations } from './migrations';
import { expectReject } from './testing';

/**
 * MMR-84 migration 0006 — widening the `node.lifecycle` CHECK is a full table
 * rebuild (SQLite can't ALTER a CHECK in place). These tests pin the two things
 * a rebuild can silently break: that existing rows across every node-referencing
 * table survive verbatim, and that the new constraint accepts `under_review`
 * while still rejecting garbage and the multi-column structural invariants.
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

/** Apply every migration strictly before 0006 — the pre-rebuild baseline. */
async function dbAt0005() {
  const db = createDb(':memory:');
  const migrator = new Migrator({ db, provider: new MapProvider(migrations) });
  const { error } = await migrator.migrateTo('0005_project_description');
  if (error !== undefined) {
    throw error;
  }
  return db;
}

function apply0006(db: ReturnType<typeof createDb>) {
  const migrator = new Migrator({ db, provider: new MapProvider(migrations) });
  return migrator.migrateToLatest();
}

test('0006 preserves rows and FK integrity across every node-referencing table', async () => {
  const db = await dbAt0005();
  try {
    // Seed a representative graph at 0005 (pre-rebuild).
    await sql`INSERT INTO project (id, key, name) VALUES (1, 'MMR', 'm')`.execute(db);
    await sql`INSERT INTO node (id, project_id, type, seq, title) VALUES (10, 1, 'initiative', 1, 'init')`.execute(
      db,
    );
    await sql`INSERT INTO node (id, project_id, type, parent_id, seq, title, lifecycle, hold, rank)
              VALUES (11, 1, 'task', 10, 2, 'prereq', 'in_progress', 'none', 65536)`.execute(db);
    await sql`INSERT INTO node (id, project_id, type, parent_id, seq, title, lifecycle, hold)
              VALUES (12, 1, 'task', 10, 3, 'dependent', 'todo', 'none')`.execute(db);
    await sql`INSERT INTO dependency (node_id, depends_on_node_id) VALUES (12, 11)`.execute(db);
    await sql`INSERT INTO annotation (id, node_id, content) VALUES (1, 11, 'note')`.execute(db);
    await sql`INSERT INTO transition_log (id, node_id, kind, from_value, to_value)
              VALUES (1, 11, 'lifecycle', 'todo', 'in_progress')`.execute(db);
    await sql`INSERT INTO artifact (id, project_id, seq, title, content) VALUES (1, 1, 1, 'spec', '# s')`.execute(
      db,
    );
    await sql`INSERT INTO artifact_link (artifact_id, node_id) VALUES (1, 11)`.execute(db);

    const { error } = await apply0006(db);
    expect(error).toBeUndefined();

    // Every row survived, verbatim.
    const node = await db.selectFrom('node').selectAll().where('id', '=', 11).executeTakeFirst();
    expect(node?.title).toBe('prereq');
    expect(node?.lifecycle).toBe('in_progress');
    expect(node?.rank).toBe(65536); // rank preserved exactly
    const counts = {
      annotation: (await db.selectFrom('annotation').selectAll().execute()).length,
      dependency: (await db.selectFrom('dependency').selectAll().execute()).length,
      link: (await db.selectFrom('artifact_link').selectAll().execute()).length,
      node: (await db.selectFrom('node').selectAll().execute()).length,
      transition: (await db.selectFrom('transition_log').selectAll().execute()).length,
    };
    expect(counts).toEqual({ annotation: 1, dependency: 1, link: 1, node: 3, transition: 1 });

    // FK enforcement is back ON: a dependency to a missing node is rejected.
    await expectReject(() =>
      sql`INSERT INTO dependency (node_id, depends_on_node_id) VALUES (12, 9999)`.execute(db),
    );
  } finally {
    await db.destroy();
  }
});

test('0006 widens the CHECK: under_review accepted, garbage and bad structure rejected', async () => {
  const db = await dbAt0005();
  try {
    await sql`INSERT INTO project (id, key, name) VALUES (1, 'MMR', 'm')`.execute(db);
    await sql`INSERT INTO node (id, project_id, type, seq, title) VALUES (10, 1, 'initiative', 1, 'init')`.execute(
      db,
    );
    const { error } = await apply0006(db);
    expect(error).toBeUndefined();

    // under_review is now a legal lifecycle.
    await sql`INSERT INTO node (id, project_id, type, parent_id, seq, title, lifecycle, hold)
              VALUES (11, 1, 'task', 10, 2, 't', 'under_review', 'none')`.execute(db);
    expect(
      (await db.selectFrom('node').select('lifecycle').where('id', '=', 11).executeTakeFirst())
        ?.lifecycle,
    ).toBe('under_review');

    // A bogus lifecycle is still rejected.
    await expectReject(() =>
      sql`INSERT INTO node (project_id, type, parent_id, seq, title, lifecycle, hold)
          VALUES (1, 'task', 10, 3, 'x', 'reviewing', 'none')`.execute(db),
    );
    // The structural invariant still holds (a container carries no lifecycle).
    await expectReject(() =>
      sql`INSERT INTO node (project_id, type, parent_id, seq, title, lifecycle)
          VALUES (1, 'phase', 10, 4, 'p', 'under_review')`.execute(db),
    );
  } finally {
    await db.destroy();
  }
});
