import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Hold, Lifecycle } from "@mimir/contract";
import { createTestDb } from "../db/testing";
import type { Db } from "./context";
import { createInitiative, createPhase, createProject, createTask } from "./create";
import { leafDistribution } from "./derive";

/**
 * MMR-105 — the per-project leaf-status tally. The leaf-level sibling of
 * `childDistribution` (direct children) / `rootDistribution` (project roots):
 * every leaf task in the project, its derived status word tallied. Backs the
 * project card's vitals panel (MMR-106).
 */

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

test("an empty project tallies to {}", async () => {
  const { p } = await fixture();
  expect(await leafDistribution(db, p.id)).toEqual({});
});

test("tallies every leaf task's derived status word across the whole project", async () => {
  const { p, phase } = await fixture();
  // ready (fresh), in_progress, under_review, blocked
  await createTask(db, { parentId: phase.id, title: "ready" });
  const prog = await createTask(db, { parentId: phase.id, title: "prog" });
  await patch(prog.id, { lifecycle: "in_progress" });
  const review = await createTask(db, { parentId: phase.id, title: "review" });
  await patch(review.id, { lifecycle: "under_review" });
  const blocked = await createTask(db, { parentId: phase.id, title: "blocked" });
  await patch(blocked.id, { hold: "blocked" });

  expect(await leafDistribution(db, p.id)).toEqual({
    ready: 1,
    in_progress: 1,
    under_review: 1,
    blocked: 1,
  });
});

test("tallies the held and terminal buckets too (parked / done / abandoned)", async () => {
  const { p, phase } = await fixture();
  const parked = await createTask(db, { parentId: phase.id, title: "parked" });
  await patch(parked.id, { hold: "parked" });
  const done = await createTask(db, { parentId: phase.id, title: "done" });
  await patch(done.id, { lifecycle: "done" });
  const gone = await createTask(db, { parentId: phase.id, title: "gone" });
  await patch(gone.id, { lifecycle: "abandoned" });
  expect(await leafDistribution(db, p.id)).toEqual({ parked: 1, done: 1, abandoned: 1 });
});

test("counts the derived awaiting word (todo with an unsettled prerequisite)", async () => {
  const { p, phase } = await fixture();
  const a = await createTask(db, { parentId: phase.id, title: "a" });
  const b = await createTask(db, { parentId: phase.id, title: "b" });
  await dep(b.id, a.id); // b awaits a; a is ready
  expect(await leafDistribution(db, p.id)).toEqual({ ready: 1, awaiting: 1 });
});

test("tallies leaves across multiple phases, excluding the containers themselves", async () => {
  const { p, init } = await fixture();
  const ph2 = await createPhase(db, { parentId: init.id, title: "ph2" });
  await createTask(db, { parentId: ph2.id, title: "x" });
  // first phase has no tasks; second has one ready leaf
  const dist = await leafDistribution(db, p.id);
  // only the single leaf task is counted — initiatives/phases never appear
  expect(dist).toEqual({ ready: 1 });
});

test("scopes to the project — no cross-project leak", async () => {
  const { p, phase } = await fixture("AAA");
  await createTask(db, { parentId: phase.id, title: "mine" });
  const other = await fixture("BBB");
  await createTask(db, { parentId: other.phase.id, title: "theirs" });
  const stuck = await createTask(db, { parentId: other.phase.id, title: "stuck" });
  await patch(stuck.id, { hold: "blocked" });

  expect(await leafDistribution(db, p.id)).toEqual({ ready: 1 });
  expect(await leafDistribution(db, other.p.id)).toEqual({ ready: 1, blocked: 1 });
});
