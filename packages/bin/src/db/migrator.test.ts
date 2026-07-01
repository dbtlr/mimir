import { expect, test } from 'bun:test';

import { createDb } from './client';
import { migrateToLatest, migrationStatus } from './migrator';

test('migrateToLatest applies the bundled migrations on a fresh db', async () => {
  const db = createDb(':memory:');
  try {
    const { error, results } = await migrateToLatest(db);

    expect(error).toBeUndefined();
    expect(results).toBeDefined();
    expect(results?.map((r) => r.migrationName)).toEqual([
      '0001_init',
      '0002_artifact_seq',
      '0003_artifact_title',
      '0004_drop_repo_path',
      '0005_project_description',
      '0006_lifecycle_under_review',
      '0007_project_archive',
    ]);
    expect(results?.every((r) => r.status === 'Success')).toBe(true);
  } finally {
    await db.destroy();
  }
});

test('migrationStatus reports applied migrations after migrating', async () => {
  const db = createDb(':memory:');
  try {
    await migrateToLatest(db);
    const all = await migrationStatus(db);

    expect(all.map((m) => m.name)).toEqual([
      '0001_init',
      '0002_artifact_seq',
      '0003_artifact_title',
      '0004_drop_repo_path',
      '0005_project_description',
      '0006_lifecycle_under_review',
      '0007_project_archive',
    ]);
    expect(all.every((m) => m.executedAt !== undefined)).toBe(true);
  } finally {
    await db.destroy();
  }
});

test('migrateToLatest is idempotent — a second run applies nothing', async () => {
  const db = createDb(':memory:');
  try {
    await migrateToLatest(db);
    const { error, results } = await migrateToLatest(db);

    expect(error).toBeUndefined();
    expect(results).toEqual([]);
  } finally {
    await db.destroy();
  }
});

test('0002 backfills per-project artifact seqs and the allocator', async () => {
  const db = createDb(':memory:');
  try {
    // Stop at the initial schema, seed artifacts pre-seq, then migrate forward.
    const { Migrator } = await import('kysely');
    const { migrations } = await import('./migrations');
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const first = await migrator.migrateTo('0001_init');
    expect(first.error).toBeUndefined();

    const { sql } = await import('kysely');
    await sql`INSERT INTO project (key, name) VALUES ('AAA', 'a'), ('BBB', 'b')`.execute(db);
    await sql`INSERT INTO artifact (project_id, content) VALUES (1, 'a1'), (2, 'b1'), (1, 'a2')`.execute(
      db,
    );

    const rest = await migrator.migrateToLatest();
    expect(rest.error).toBeUndefined();

    const artifacts = await db
      .selectFrom('artifact')
      .select(['project_id', 'seq', 'content'])
      .orderBy('id', 'asc')
      .execute();
    expect(artifacts).toEqual([
      { content: 'a1', project_id: 1, seq: 1 },
      { content: 'b1', project_id: 2, seq: 1 },
      { content: 'a2', project_id: 1, seq: 2 },
    ]);

    const allocators = await db
      .selectFrom('project')
      .select(['key', 'last_artifact_seq'])
      .orderBy('id', 'asc')
      .execute();
    expect(allocators).toEqual([
      { key: 'AAA', last_artifact_seq: 2 },
      { key: 'BBB', last_artifact_seq: 1 },
    ]);
  } finally {
    await db.destroy();
  }
});

test('0003 backfills artifact titles from the first markdown heading', async () => {
  const db = createDb(':memory:');
  try {
    const { Migrator, sql } = await import('kysely');
    const { migrations } = await import('./migrations');
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const upTo = await migrator.migrateTo('0002_artifact_seq');
    expect(upTo.error).toBeUndefined();

    await sql`INSERT INTO project (key, name) VALUES ('AAA', 'a')`.execute(db);
    await sql`INSERT INTO artifact (project_id, seq, content)
              VALUES (1, 1, ${'# Session Log\n\nbody'}), (1, 2, ${'no heading here'})`.execute(db);

    const rest = await migrator.migrateToLatest();
    expect(rest.error).toBeUndefined();

    const rows = await db.selectFrom('artifact').select(['seq', 'title']).orderBy('seq').execute();
    expect(rows).toEqual([
      { seq: 1, title: 'Session Log' },
      { seq: 2, title: 'untitled' },
    ]);
  } finally {
    await db.destroy();
  }
});

test('0005 adds description column to project (MMR-88)', async () => {
  const db = createDb(':memory:');
  try {
    const { Migrator, sql } = await import('kysely');
    const { migrations } = await import('./migrations');
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const upTo = await migrator.migrateTo('0004_drop_repo_path');
    expect(upTo.error).toBeUndefined();

    await sql`INSERT INTO project (key, name, last_seq) VALUES ('AAA', 'a', 0)`.execute(db);

    const rest = await migrator.migrateToLatest();
    expect(rest.error).toBeUndefined();

    const cols = await sql<{
      name: string;
    }>`SELECT name FROM pragma_table_info('project')`.execute(db);
    expect(cols.rows.map((r) => r.name)).toContain('description');

    // Existing row backfills to NULL
    const rows = await db.selectFrom('project').select(['key', 'description']).execute();
    expect(rows).toEqual([{ description: null, key: 'AAA' }]);
  } finally {
    await db.destroy();
  }
});

test('0004 drops project repo/path, preserving every other column (ADR 0011)', async () => {
  const db = createDb(':memory:');
  try {
    const { Migrator, sql } = await import('kysely');
    const { migrations } = await import('./migrations');
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const upTo = await migrator.migrateTo('0003_artifact_title');
    expect(upTo.error).toBeUndefined();

    await sql`INSERT INTO project (key, name, repo, path, last_seq)
              VALUES ('AAA', 'a', 'git@host:a.git', '/home/x/a', 7)`.execute(db);

    const rest = await migrator.migrateToLatest();
    expect(rest.error).toBeUndefined();

    const cols = await sql<{ name: string }>`SELECT name FROM pragma_table_info('project')`.execute(
      db,
    );
    const names = cols.rows.map((r) => r.name);
    expect(names).not.toContain('repo');
    expect(names).not.toContain('path');

    const rows = await db.selectFrom('project').select(['key', 'name', 'last_seq']).execute();
    expect(rows).toEqual([{ key: 'AAA', last_seq: 7, name: 'a' }]);
  } finally {
    await db.destroy();
  }
});
