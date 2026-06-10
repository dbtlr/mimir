import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, expectReject } from "../../db/testing";
import type { Db } from "../context";
import { createInitiative, createPhase, createProject, createTask } from "../create";
import { attachArtifact, blockTask, completeTask, depend, startTask } from "../mutations";
import { getArtifact, getNode, listNodes, nextTasks, statusOfNode } from "./index";

let db: Db;
let phaseId: number;
let key: string;
beforeEach(async () => {
  db = await createTestDb();
  const p = await createProject(db, { key: "MMR", name: "m" });
  key = p.key;
  const init = await createInitiative(db, { projectId: p.id, title: "i" });
  const phase = await createPhase(db, { parentId: init.id, title: "ph" });
  phaseId = phase.id;
});
afterEach(async () => {
  await db.destroy();
});

const idOf = (n: { seq: number }) => `${key}-${n.seq}`;

test("next returns ready tasks in rank order, excluding awaiting/held", async () => {
  const a = await createTask(db, { parentId: phaseId, title: "a" });
  const b = await createTask(db, { parentId: phaseId, title: "b" });
  const c = await createTask(db, { parentId: phaseId, title: "c" });
  // b awaits a; c is blocked → only a and (later) others are ready
  await depend(db, b.id, [a.id]);
  await blockTask(db, c.id, "later");

  const res = await nextTasks(db, { scope: key });
  expect(res.items.map((n) => n.id)).toEqual([idOf(a)]);
  expect(res.total).toBe(1);
  expect(res.items[0]?.status).toBe("ready");

  // completing a unblocks b
  await completeTask(db, a.id);
  const res2 = await nextTasks(db, { scope: key });
  expect(res2.items.map((n) => n.id)).toEqual([idOf(b)]);
});

test("next respects priority filter and the limit", async () => {
  await createTask(db, { parentId: phaseId, title: "p2", priority: "p2" });
  const hi = await createTask(db, { parentId: phaseId, title: "p0", priority: "p0" });
  const onlyP0 = await nextTasks(db, { scope: key, priority: "p0" });
  expect(onlyP0.items.map((n) => n.id)).toEqual([idOf(hi)]);

  const limited = await nextTasks(db, { scope: key, limit: 1 });
  expect(limited.returned).toBe(1);
  expect(limited.total).toBe(2); // total reflects the full ready set
});

test("get returns a full record with cheap facets and resolves KEY-seq", async () => {
  const a = await createTask(db, { parentId: phaseId, title: "a" });
  const b = await createTask(db, { parentId: phaseId, title: "b" });
  await depend(db, b.id, [a.id]);

  const view = await getNode(db, idOf(b));
  expect(view.id).toBe(idOf(b));
  expect(view.title).toBe("b");
  expect(view.lifecycle).toBe("todo");
  expect(view.deps?.dependsOn.map((r) => r.id)).toEqual([idOf(a)]);
  expect(view.tags).toEqual([]); // cheap facet present, empty
  expect(view.history).toBeUndefined(); // heavy facet opt-in
});

test("get throws on a missing or malformed id", async () => {
  await expectReject(() => getNode(db, "MMR-999"));
  await expectReject(() => getNode(db, "not-an-id"));
});

test("status_of returns label + distribution for a non-leaf", async () => {
  const t1 = await createTask(db, { parentId: phaseId, title: "t1" });
  await createTask(db, { parentId: phaseId, title: "t2" });
  await startTask(db, t1.id);

  const phase = await db
    .selectFrom("node")
    .select("seq")
    .where("id", "=", phaseId)
    .executeTakeFirstOrThrow();
  const status = await statusOfNode(db, `${key}-${String(phase.seq)}`);
  expect(status.status).toBe("in_progress");
  expect(status.distribution).toEqual({ in_progress: 1, ready: 1 });
});

// addressability (MMR-32): the full grammar on get/status

test("get on a bare KEY returns the whole-project view", async () => {
  const t = await createTask(db, { parentId: phaseId, title: "t" });
  await startTask(db, t.id);

  const view = await getNode(db, key);
  expect(view.id).toBe(key);
  expect(view.type).toBe("project");
  expect(view.title).toBe("m");
  expect(view.status).toBe("in_progress"); // interpret over the root initiative
  expect(view.children?.length).toBe(1); // the root initiative
  expect(view.distribution).toEqual({ in_progress: 1 });
});

test("status_of on a bare KEY rolls up the project's roots", async () => {
  const t = await createTask(db, { parentId: phaseId, title: "t" });
  await startTask(db, t.id);

  const status = await statusOfNode(db, key);
  expect(status.id).toBe(key);
  expect(status.status).toBe("in_progress");
  expect(status.distribution).toEqual({ in_progress: 1 });
});

test("get on KEY-aN returns the artifact detail with rendered links", async () => {
  const t = await createTask(db, { parentId: phaseId, title: "t" });
  const project = await db.selectFrom("project").select("id").executeTakeFirstOrThrow();
  const { renderedId } = await attachArtifact(db, {
    projectId: project.id,
    content: "# frozen\n",
    linkNodeIds: [t.id],
  });
  expect(renderedId).toBe(`${key}-a1`);

  const detail = await getArtifact(db, renderedId);
  expect(detail.id).toBe(`${key}-a1`);
  expect(detail.project).toBe(key);
  expect(detail.links).toEqual([idOf(t)]);
});

test("status_of rejects an artifact id as a behavioral error", async () => {
  await expectReject(() => statusOfNode(db, `${key}-a1`));
});

test("the node artifacts facet speaks KEY-aN", async () => {
  const t = await createTask(db, { parentId: phaseId, title: "t" });
  const project = await db.selectFrom("project").select("id").executeTakeFirstOrThrow();
  await attachArtifact(db, { projectId: project.id, content: "x", linkNodeIds: [t.id] });

  const view = await getNode(db, idOf(t));
  expect(view.artifacts?.map((a) => a.id)).toEqual([`${key}-a1`]);

  const projectView = await getNode(db, key, { facets: ["artifacts"] });
  expect(projectView.artifacts?.map((a) => a.id)).toEqual([`${key}-a1`]);
});

test("list selects by predicate", async () => {
  const a = await createTask(db, { parentId: phaseId, title: "a" });
  const b = await createTask(db, { parentId: phaseId, title: "b" });
  await blockTask(db, b.id, "x");

  const blocked = await listNodes(db, { scope: key, predicate: "blocked" });
  expect(blocked.items.map((n) => n.id)).toEqual([idOf(b)]);

  const ready = await listNodes(db, { scope: key, predicate: "ready" });
  expect(ready.items.map((n) => n.id)).toEqual([idOf(a)]);

  const all = await listNodes(db, { scope: key, predicate: "all" });
  expect(all.total).toBe(2); // both non-terminal tasks
});
