import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb } from "../../db/testing";
import type { Db } from "../context";
import { createInitiative, createPhase, createProject, createTask } from "../create";
import { loadNode } from "../lookup";
import { RANK_STEP } from "../rank";
import { expectMimirError } from "../testing";
import {
  abandonTask,
  annotate,
  attachArtifact,
  blockTask,
  completeTask,
  depend,
  moveNode,
  parkTask,
  reorder,
  startTask,
  unblockTask,
  unparkTask,
  undepend,
  updateNode,
} from "./index";

let db: Db;
let projectId: number;
let initId: number;
let phaseId: number;
beforeEach(async () => {
  db = await createTestDb();
  const p = await createProject(db, { key: "MMR", name: "m" });
  projectId = p.id;
  const init = await createInitiative(db, { projectId, title: "i" });
  initId = init.id;
  const phase = await createPhase(db, { parentId: init.id, title: "ph" });
  phaseId = phase.id;
});
afterEach(async () => {
  await db.destroy();
});

async function task(title = "t"): Promise<number> {
  const t = await createTask(db, { parentId: phaseId, title });
  return t.id;
}
async function reload(id: number) {
  const node = await loadNode(db, id);
  if (node === undefined) throw new Error(`node ${id} vanished`);
  return node;
}
async function logs(nodeId: number) {
  return db
    .selectFrom("transition_log")
    .select(["kind", "from_value", "to_value", "reason"])
    .where("node_id", "=", nodeId)
    .orderBy("id", "asc")
    .execute();
}

test("start keeps rank and logs a lifecycle transition", async () => {
  const id = await task();
  const before = await reload(id);
  expect(before.rank).toBe(RANK_STEP);
  const echoed = await startTask(db, id);
  expect(echoed.lifecycle).toBe("in_progress");
  expect(echoed.rank).toBe(RANK_STEP); // todo->in_progress stays in the rankable set
  expect(await logs(id)).toEqual([
    { kind: "lifecycle", from_value: "todo", to_value: "in_progress", reason: null },
  ]);
  await expectMimirError("validation", () => startTask(db, id)); // not a todo anymore
});

test("complete is terminal: stamps completed_at and clears rank", async () => {
  const id = await task();
  await startTask(db, id);
  const done = await completeTask(db, id);
  expect(done.lifecycle).toBe("done");
  expect(done.completed_at).not.toBeNull();
  expect(done.rank).toBeNull();
  await expectMimirError("validation", () => completeTask(db, id)); // already terminal
});

test("abandon clears rank and records its reason on the log row", async () => {
  const id = await task();
  const gone = await abandonTask(db, id, "scope cut");
  expect(gone.lifecycle).toBe("abandoned");
  expect(gone.rank).toBeNull();
  expect(gone.completed_at).toBeNull(); // only complete stamps it
  expect((await logs(id)).at(-1)).toEqual({
    kind: "lifecycle",
    from_value: "todo",
    to_value: "abandoned",
    reason: "scope cut",
  });
});

test("park/unpark and block/unblock leave and re-enter the rankable set", async () => {
  const id = await task();
  const parked = await parkTask(db, id, "later");
  expect(parked.hold).toBe("parked");
  expect(parked.hold_reason).toBe("later");
  expect(parked.rank).toBeNull();
  await expectMimirError("validation", () => parkTask(db, id)); // already held

  const unparked = await unparkTask(db, id);
  expect(unparked.hold).toBe("none");
  expect(unparked.hold_reason).toBeNull();
  expect(unparked.rank).toBe(RANK_STEP); // re-appended to bottom (only task)

  const blocked = await blockTask(db, id, "waiting on API");
  expect(blocked.hold).toBe("blocked");
  expect(blocked.rank).toBeNull();
  const unblocked = await unblockTask(db, id);
  expect(unblocked.hold).toBe("none");
  expect(unblocked.rank).toBe(RANK_STEP);

  expect((await logs(id)).map((l) => `${String(l.from_value)}>${String(l.to_value)}`)).toEqual([
    "none>parked",
    "parked>none",
    "none>blocked",
    "blocked>none",
  ]);
});

test("depend builds acyclic edges and rejects cycles and self-deps", async () => {
  const a = await task("a");
  const b = await task("b");
  const c = await task("c");
  await depend(db, b, [a]); // b depends on a
  await depend(db, c, [b]); // c depends on b
  await expectMimirError("validation", () => depend(db, a, [c])); // a->c would close a->c->b->a
  await expectMimirError("validation", () => depend(db, a, [a])); // self

  const edges = await db.selectFrom("dependency").selectAll().where("node_id", "=", b).execute();
  expect(edges).toHaveLength(1);
  expect((await logs(b)).at(-1)?.kind).toBe("dependency");

  await undepend(db, b, [a]);
  expect(
    await db.selectFrom("dependency").selectAll().where("node_id", "=", b).execute(),
  ).toHaveLength(0);
});

test("move re-parents with type + cycle validation", async () => {
  const phase2 = await createPhase(db, { parentId: initId, title: "ph2" });
  const t = await task("t");
  const moved = await moveNode(db, t, phase2.id);
  expect(moved.parent_id).toBe(phase2.id);
  expect((await logs(t)).at(-1)?.kind).toBe("move");

  // a task cannot parent to another task
  const other = await task("other");
  await expectMimirError("validation", () => moveNode(db, t, other));
  // a phase cannot move under its own descendant task... use node cycle: move init under its phase
  await expectMimirError("validation", () => moveNode(db, initId, phaseId));
  // an initiative may go top-level
  const reparented = await moveNode(db, initId, null);
  expect(reparented.parent_id).toBeNull();
});

test("update is a dumb scalar patch with type-applicability checks", async () => {
  const id = await task();
  const patched = await updateNode(db, id, { title: "renamed", priority: "p0" });
  expect(patched.title).toBe("renamed");
  expect(patched.priority).toBe("p0");

  // target is phase-only; priority is task-only
  await expectMimirError("validation", () => updateNode(db, id, { target: "x" }));
  await expectMimirError("validation", () => updateNode(db, phaseId, { priority: "p1" }));

  // status is not reachable through update (lifecycle unchanged)
  expect((await reload(id)).lifecycle).toBe("todo");
});

test("annotate and attachArtifact persist and link", async () => {
  const id = await task();
  await annotate(db, id, "realized X");
  const notes = await db.selectFrom("annotation").selectAll().where("node_id", "=", id).execute();
  expect(notes.map((n) => n.content)).toEqual(["realized X"]);

  const { id: artifactId } = await attachArtifact(db, {
    projectId,
    title: "session log",
    content: "# session log",
    linkNodeIds: [id],
  });
  const links = await db
    .selectFrom("artifact_link")
    .selectAll()
    .where("artifact_id", "=", artifactId)
    .execute();
  expect(links.map((l) => l.node_id)).toEqual([id]);
});

test("reorder moves within the rankable set and refuses terminal/held tasks", async () => {
  const a = await task("a");
  const b = await task("b");
  await reorder(db, b, "top");
  const ranked = await db
    .selectFrom("node")
    .select("id")
    .where("project_id", "=", projectId)
    .where("rank", "is not", null)
    .orderBy("rank", "asc")
    .execute();
  expect(ranked.map((r) => r.id)).toEqual([b, a]);

  await completeTask(db, a);
  await expectMimirError("validation", () => reorder(db, a, "top")); // terminal -> no rank
});
