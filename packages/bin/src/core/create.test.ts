import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Db } from "./context";
import { createInitiative, createPhase, createProject, createTask } from "./create";
import { RANK_STEP } from "./rank";
import { createTestDb } from "../db/testing";
import { expectMimirError } from "./testing";

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});
afterEach(async () => {
  await db.destroy();
});

test("createProject inserts and defaults last_seq to 0", async () => {
  const p = await createProject(db, { key: "MMR", name: "Mimir" });
  expect(p.key).toBe("MMR");
  expect(p.last_seq).toBe(0);
});

test("createProject stores optional description (MMR-88)", async () => {
  const withDesc = await createProject(db, {
    key: "MMR",
    name: "Mimir",
    description: "tracks work",
  });
  expect(withDesc.description).toBe("tracks work");

  const withoutDesc = await createProject(db, { key: "NRN", name: "Norn" });
  expect(withoutDesc.description).toBeNull();
});

test("createProject rejects a bad key and a duplicate key", async () => {
  await expectMimirError("validation", () => createProject(db, { key: "m1", name: "bad" }));
  await expectMimirError("validation", () => createProject(db, { key: "TOOLONG", name: "bad" }));
  await createProject(db, { key: "MMR", name: "Mimir" });
  await expectMimirError("conflict", () => createProject(db, { key: "MMR", name: "again" }));
});

test("seq is per-project, monotonic, and shared across node types", async () => {
  const p = await createProject(db, { key: "MMR", name: "Mimir" });
  const init = await createInitiative(db, { projectId: p.id, title: "i" });
  const phase = await createPhase(db, { parentId: init.id, title: "ph" });
  const task = await createTask(db, { parentId: phase.id, title: "t" });
  expect([init.seq, phase.seq, task.seq]).toEqual([1, 2, 3]);

  // a second project allocates independently
  const q = await createProject(db, { key: "NRN", name: "Norn" });
  const init2 = await createInitiative(db, { projectId: q.id, title: "i2" });
  expect(init2.seq).toBe(1);
});

test("createInitiative is top-level (null parent) and requires a real project", async () => {
  const p = await createProject(db, { key: "MMR", name: "Mimir" });
  const init = await createInitiative(db, { projectId: p.id, title: "i" });
  expect(init.type).toBe("initiative");
  expect(init.parent_id).toBeNull();
  expect(init.lifecycle).toBeNull(); // non-tasks store no status
  await expectMimirError("not_found", () => createInitiative(db, { projectId: 999, title: "x" }));
});

test("createPhase requires an initiative parent and inherits project_id", async () => {
  const p = await createProject(db, { key: "MMR", name: "Mimir" });
  const init = await createInitiative(db, { projectId: p.id, title: "i" });
  const phase = await createPhase(db, { parentId: init.id, title: "ph", target: "ship it" });
  expect(phase.type).toBe("phase");
  expect(phase.project_id).toBe(p.id);
  expect(phase.parent_id).toBe(init.id);
  expect(phase.target).toBe("ship it");

  // a phase under a phase is rejected
  await expectMimirError("validation", () => createPhase(db, { parentId: phase.id, title: "no" }));
  await expectMimirError("not_found", () => createPhase(db, { parentId: 999, title: "no" }));
});

test("createTask sets both axes, ranks at append step, and accepts phase or initiative parents", async () => {
  const p = await createProject(db, { key: "MMR", name: "Mimir" });
  const init = await createInitiative(db, { projectId: p.id, title: "i" });
  const phase = await createPhase(db, { parentId: init.id, title: "ph" });

  const t1 = await createTask(db, {
    parentId: phase.id,
    title: "t1",
    priority: "p1",
    size: "small",
  });
  expect(t1.type).toBe("task");
  expect(t1.lifecycle).toBe("todo");
  expect(t1.hold).toBe("none");
  expect(t1.priority).toBe("p1");
  expect(t1.rank).toBe(RANK_STEP);

  const t2 = await createTask(db, { parentId: phase.id, title: "t2" });
  expect(t2.rank).toBe(RANK_STEP * 2); // appends below t1

  // a task directly under an initiative is allowed (phaseless initiative)
  const t3 = await createTask(db, { parentId: init.id, title: "t3" });
  expect(t3.parent_id).toBe(init.id);

  // a task under a task is rejected
  await expectMimirError("validation", () => createTask(db, { parentId: t1.id, title: "no" }));
});
