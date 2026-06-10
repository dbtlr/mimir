import { expect, test } from "bun:test";
import { createDb } from "./client";
import { migrateToLatest, migrationStatus } from "./migrator";

test("migrateToLatest applies the bundled migrations on a fresh db", async () => {
  const db = createDb(":memory:");
  try {
    const { error, results } = await migrateToLatest(db);

    expect(error).toBeUndefined();
    expect(results).toBeDefined();
    expect(results?.map((r) => r.migrationName)).toEqual(["0001_init", "0002_artifact_seq"]);
    expect(results?.every((r) => r.status === "Success")).toBe(true);
  } finally {
    await db.destroy();
  }
});

test("migrationStatus reports applied migrations after migrating", async () => {
  const db = createDb(":memory:");
  try {
    await migrateToLatest(db);
    const all = await migrationStatus(db);

    expect(all.map((m) => m.name)).toEqual(["0001_init", "0002_artifact_seq"]);
    expect(all.every((m) => m.executedAt !== undefined)).toBe(true);
  } finally {
    await db.destroy();
  }
});

test("migrateToLatest is idempotent — a second run applies nothing", async () => {
  const db = createDb(":memory:");
  try {
    await migrateToLatest(db);
    const { error, results } = await migrateToLatest(db);

    expect(error).toBeUndefined();
    expect(results).toEqual([]);
  } finally {
    await db.destroy();
  }
});

test("0002 backfills per-project artifact seqs and the allocator", async () => {
  const db = createDb(":memory:");
  try {
    // Stop at the initial schema, seed artifacts pre-seq, then migrate forward.
    const { Migrator } = await import("kysely");
    const { migrations } = await import("./migrations");
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const first = await migrator.migrateTo("0001_init");
    expect(first.error).toBeUndefined();

    const { sql } = await import("kysely");
    await sql`INSERT INTO project (key, name) VALUES ('AAA', 'a'), ('BBB', 'b')`.execute(db);
    await sql`INSERT INTO artifact (project_id, content) VALUES (1, 'a1'), (2, 'b1'), (1, 'a2')`.execute(
      db,
    );

    const rest = await migrator.migrateToLatest();
    expect(rest.error).toBeUndefined();

    const artifacts = await db
      .selectFrom("artifact")
      .select(["project_id", "seq", "content"])
      .orderBy("id", "asc")
      .execute();
    expect(artifacts).toEqual([
      { project_id: 1, seq: 1, content: "a1" },
      { project_id: 2, seq: 1, content: "b1" },
      { project_id: 1, seq: 2, content: "a2" },
    ]);

    const allocators = await db
      .selectFrom("project")
      .select(["key", "last_artifact_seq"])
      .orderBy("id", "asc")
      .execute();
    expect(allocators).toEqual([
      { key: "AAA", last_artifact_seq: 2 },
      { key: "BBB", last_artifact_seq: 1 },
    ]);
  } finally {
    await db.destroy();
  }
});
