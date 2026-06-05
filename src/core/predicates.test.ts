import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Hold, Lifecycle } from "../contract/enums";
import { createTestDb } from "../db/testing";
import type { Db } from "./context";
import { createInitiative, createPhase, createProject, createTask } from "./create";
import { loadNode } from "./lookup";
import { isAwaiting, isBlocked, isBlocking, isOrphaned, isReady, isStale } from "./predicates";

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});
afterEach(async () => {
  await db.destroy();
});

async function patch(id: number, fields: { lifecycle?: Lifecycle; hold?: Hold }): Promise<void> {
  await db.updateTable("node").set(fields).where("id", "=", id).execute();
}
async function reload(id: number) {
  const node = await loadNode(db, id);
  if (node === undefined) throw new Error(`node ${id} vanished`);
  return node;
}
async function dep(nodeId: number, dependsOn: number): Promise<void> {
  await db
    .insertInto("dependency")
    .values({ node_id: nodeId, depends_on_node_id: dependsOn })
    .execute();
}

async function fixture(key = "MMR") {
  const p = await createProject(db, { key, name: "m" });
  const init = await createInitiative(db, { projectId: p.id, title: "i" });
  const phase = await createPhase(db, { parentId: init.id, title: "ph" });
  return { p, init, phase };
}

test("ready vs awaiting hinge on prerequisite settledness", async () => {
  const { phase } = await fixture();
  const a = await createTask(db, { parentId: phase.id, title: "a" });
  const b = await createTask(db, { parentId: phase.id, title: "b" });
  expect(await isReady(db, a)).toBe(true);
  expect(await isAwaiting(db, a)).toBe(false);

  await dep(b.id, a.id);
  expect(await isReady(db, await reload(b.id))).toBe(false);
  expect(await isAwaiting(db, await reload(b.id))).toBe(true);

  await patch(a.id, { lifecycle: "done" });
  expect(await isReady(db, await reload(b.id))).toBe(true);
  expect(await isAwaiting(db, await reload(b.id))).toBe(false);
});

test("a held task is neither ready nor awaiting", async () => {
  const { phase } = await fixture();
  const t = await createTask(db, { parentId: phase.id, title: "t" });
  await patch(t.id, { hold: "blocked" });
  expect(await isReady(db, await reload(t.id))).toBe(false);
  expect(await isAwaiting(db, await reload(t.id))).toBe(false);
  expect(isBlocked(await reload(t.id))).toBe(true);
});

test("blocking is true while an unsettled dependent exists", async () => {
  const { phase } = await fixture();
  const prereq = await createTask(db, { parentId: phase.id, title: "prereq" });
  const dependent = await createTask(db, { parentId: phase.id, title: "dependent" });
  await dep(dependent.id, prereq.id);

  expect(await isBlocking(db, await reload(prereq.id))).toBe(true);
  await patch(dependent.id, { lifecycle: "done" });
  expect(await isBlocking(db, await reload(prereq.id))).toBe(false);
});

test("stale chases in_progress/blocked, mutes parked/awaiting, respects the threshold", async () => {
  const { phase } = await fixture();
  const t = await createTask(db, { parentId: phase.id, title: "t" });
  await patch(t.id, { lifecycle: "in_progress" });
  // backdate updated_at well past the threshold
  await db
    .updateTable("node")
    .set({ updated_at: "2000-01-01T00:00:00.000Z" })
    .where("id", "=", t.id)
    .execute();
  const asOf = "2026-06-05T00:00:00.000Z";

  expect(await isStale(db, await reload(t.id), { asOf })).toBe(true);

  // parked is muted even when ancient
  await patch(t.id, { hold: "parked" });
  expect(await isStale(db, await reload(t.id), { asOf })).toBe(false);

  // fresh in_progress is not stale
  await patch(t.id, { hold: "none" });
  await db.updateTable("node").set({ updated_at: asOf }).where("id", "=", t.id).execute();
  expect(await isStale(db, await reload(t.id), { asOf })).toBe(false);
});

test("orphaned: a live task stranded among all-terminal siblings", async () => {
  const { phase } = await fixture();
  const live = await createTask(db, { parentId: phase.id, title: "live" });
  const sib = await createTask(db, { parentId: phase.id, title: "sib" });

  // two live siblings → not orphaned
  expect(await isOrphaned(db, await reload(live.id))).toBe(false);

  // sibling done → the live one is now stranded
  await patch(sib.id, { lifecycle: "done" });
  expect(await isOrphaned(db, await reload(live.id))).toBe(true);

  // a sole child is never orphaned
  const { phase: solo } = await fixture("SOL");
  const only = await createTask(db, { parentId: solo.id, title: "only" });
  expect(await isOrphaned(db, await reload(only.id))).toBe(false);
});
