import { expect } from "bun:test";
import type { Kysely } from "kysely";
import type { DB } from "./schema";
import { createDb } from "./client";
import { migrateToLatest } from "./migrator";

/**
 * A fresh in-memory database with all migrations applied — the substrate every
 * test runs against. Real SQLite (`:memory:`), so the actual CHECKs and FKs are
 * exercised; never a mock (ADR 0010 / storage-committed core).
 */
export async function createTestDb(): Promise<Kysely<DB>> {
  const db = createDb(":memory:");
  const { error } = await migrateToLatest(db);
  if (error !== undefined) {
    throw error instanceof Error ? error : new Error(JSON.stringify(error));
  }
  return db;
}

/**
 * Assert that an async operation rejects. Replaces `expect(p).rejects.toThrow()`
 * — bun's types declare that chain non-thenable, which trips the type-aware
 * `await-thenable` lint under our zero-warning gate.
 */
export async function expectReject(run: () => Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await run();
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
}
