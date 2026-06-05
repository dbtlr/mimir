import { afterEach, beforeEach, expect, test } from "bun:test";
import { createInitiative, createPhase, createProject, createTask, findNodeByRef } from "../core";
import type { Db } from "../core";
import { createTestDb } from "../db/testing";
import { echoNode, readContent, resolveNode, resolveParent, resolveProject } from "./resolve";
import { runCli } from "./run";
import { fakeIo } from "./testing";

let db: Db;
let taskRef: string;
beforeEach(async () => {
  db = await createTestDb();
  const p = await createProject(db, { key: "MMR", name: "m" });
  const init = await createInitiative(db, { projectId: p.id, title: "i" });
  const phase = await createPhase(db, { parentId: init.id, title: "ph" });
  const task = await createTask(db, { parentId: phase.id, title: "t" });
  taskRef = `MMR-${String(task.seq)}`;
});
afterEach(async () => {
  await db.destroy();
});

// resolveNode
test("resolveNode returns the surrogate id for a valid KEY-seq", async () => {
  const id = await resolveNode(db, taskRef);
  expect(typeof id).toBe("number");
});
test("resolveNode throws not_found (code) for a missing id", async () => {
  let threw: unknown;
  try {
    await resolveNode(db, "MMR-9999");
  } catch (e) {
    threw = e;
  }
  expect(threw).toMatchObject({ code: "not_found" });
});

// resolveProject
test("resolveProject returns the surrogate id for a valid project key", async () => {
  const id = await resolveProject(db, "MMR");
  expect(typeof id).toBe("number");
});
test("resolveProject throws not_found (code) for a missing project key", async () => {
  let threw: unknown;
  try {
    await resolveProject(db, "ZZZ");
  } catch (e) {
    threw = e;
  }
  expect(threw).toMatchObject({ code: "not_found" });
});

// resolveParent
test("resolveParent returns {kind:'project'} for a bare project key", async () => {
  const result = await resolveParent(db, "MMR");
  expect(result).toMatchObject({ kind: "project" });
  expect(typeof result.id).toBe("number");
});
test("resolveParent returns {kind:'node'} for a KEY-seq token", async () => {
  const result = await resolveParent(db, taskRef);
  expect(result).toMatchObject({ kind: "node" });
  expect(typeof result.id).toBe("number");
});

// echoNode
test("echoNode writes bare-node JSON to io.out for format 'json'", async () => {
  const node = await findNodeByRef(db, taskRef);
  if (node === undefined) throw new Error("node not found");
  const io = fakeIo();
  await echoNode(db, node.id, "json", io);
  const parsed = JSON.parse(io.out.join("")) as { id: string };
  expect(parsed.id).toBe(taskRef);
});
test("echoNode writes rendered records text to io.out for format 'records'", async () => {
  const node = await findNodeByRef(db, taskRef);
  if (node === undefined) throw new Error("node not found");
  const io = fakeIo(true);
  await echoNode(db, node.id, "records", io);
  const text = io.out.join("");
  expect(text).toContain(taskRef);
  expect(text).toContain("title");
});
test("echoNode writes the bare id to io.out for format 'ids'", async () => {
  const node = await findNodeByRef(db, taskRef);
  if (node === undefined) throw new Error("node not found");
  const io = fakeIo();
  await echoNode(db, node.id, "ids", io);
  const text = io.out.join("");
  expect(text).toBe(taskRef);
});
test("echoNode writes a count-led table line to io.out for format 'table'", async () => {
  const node = await findNodeByRef(db, taskRef);
  if (node === undefined) throw new Error("node not found");
  const io = fakeIo(true);
  await echoNode(db, node.id, "table", io);
  const text = io.out.join("");
  expect(text).toMatch(/^1 task/);
  expect(text).toContain(taskRef);
});

// readContent
test("readContent returns joined tail when tail is non-empty", async () => {
  const io = fakeIo(false);
  const result = await readContent(["hello", "world"], io);
  expect(result).toBe("hello world");
});
test("readContent returns empty string when tail is empty and isTTY", async () => {
  const io = fakeIo(true);
  const result = await readContent([], io);
  expect(result).toBe("");
});

// lifecycle verbs via runCli
test("start moves a task to in_progress and echoes it (exit 0)", async () => {
  const io = fakeIo(false);
  const code = await runCli(["start", taskRef, "-f", "json"], db, io);
  expect(code).toBe(0);
  expect(JSON.parse(io.out[0] ?? "{}").state).toBe("in_progress");
});
test("done completes a started task", async () => {
  await runCli(["start", taskRef], db, fakeIo(false));
  const io = fakeIo(false);
  const code = await runCli(["done", taskRef, "-f", "json"], db, io);
  expect(code).toBe(0);
  expect(JSON.parse(io.out[0] ?? "{}").state).toBe("done");
});
test("abandon records a reason from the positional tail", async () => {
  const code = await runCli(["abandon", taskRef, "superseded", "by", "nine"], db, fakeIo(false));
  expect(code).toBe(0);
});
test("a mutation on a missing id is not_found → exit 1", async () => {
  const io = fakeIo(false);
  expect(await runCli(["done", "MMR-9999"], db, io)).toBe(1);
  expect(io.out).toHaveLength(0);
});

// hold verbs: park / unpark / block / unblock
test("park sets the hold overlay → reads as parked", async () => {
  const io = fakeIo(false);
  const code = await runCli(["park", taskRef, "waiting", "on", "review", "-f", "json"], db, io);
  expect(code).toBe(0);
  expect(JSON.parse(io.out[0] ?? "{}").state).toBe("parked");
});
test("unpark clears the hold", async () => {
  await runCli(["park", taskRef], db, fakeIo(false));
  expect(await runCli(["unpark", taskRef], db, fakeIo(false))).toBe(0);
});
test("block then unblock", async () => {
  expect(await runCli(["block", taskRef, "ci", "red"], db, fakeIo(false))).toBe(0);
  expect(await runCli(["unblock", taskRef], db, fakeIo(false))).toBe(0);
});
