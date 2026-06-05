import { expect, test } from "bun:test";
import { createDb } from "./client";
import { migrateToLatest, migrationStatus } from "./migrator";

test("migrateToLatest applies the bundled migrations on a fresh db", async () => {
  const db = createDb(":memory:");
  try {
    const { error, results } = await migrateToLatest(db);

    expect(error).toBeUndefined();
    expect(results).toBeDefined();
    expect(results?.map((r) => r.migrationName)).toEqual(["0001_init"]);
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

    expect(all.map((m) => m.name)).toEqual(["0001_init"]);
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
