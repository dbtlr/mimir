import { afterEach, beforeEach, expect, test } from "bun:test";
import { createInitiative, createPhase, createProject, createTask } from "../core";
import type { Db } from "../core";
import { createTestDb } from "../db/testing";
import { buildMcpServer } from "./server";
import { toolGet, toolNext, toolStatus } from "./tools";

let db: Db;
let phaseId: number;
beforeEach(async () => {
  db = await createTestDb();
  const p = await createProject(db, { key: "MMR", name: "m" });
  const init = await createInitiative(db, { projectId: p.id, title: "i" });
  const phase = await createPhase(db, { parentId: init.id, title: "ph" });
  phaseId = phase.id;
});
afterEach(async () => {
  await db.destroy();
});

const textOf = (result: { content: { text: string }[] }) =>
  result.content.map((c) => c.text).join("");

test("buildMcpServer registers tools without throwing", () => {
  expect(() => buildMcpServer(db, "0.0.0")).not.toThrow();
});

test("next tool returns the structured envelope", async () => {
  await createTask(db, { parentId: phaseId, title: "first" });
  const result = await toolNext(db, { scope: "MMR" });
  expect(result.isError).toBeUndefined();
  const parsed = JSON.parse(textOf(result)) as { total: number; tasks: { title: string }[] };
  expect(parsed.total).toBe(1);
  expect(parsed.tasks[0]?.title).toBe("first");
});

test("get tool returns a bare node; a missing id is an isError result", async () => {
  const t = await createTask(db, { parentId: phaseId, title: "deep" });
  const seq = (
    await db.selectFrom("node").select("seq").where("id", "=", t.id).executeTakeFirstOrThrow()
  ).seq;

  const ok = await toolGet(db, { id: `MMR-${String(seq)}` });
  expect(ok.isError).toBeUndefined();
  expect((JSON.parse(textOf(ok)) as { title: string }).title).toBe("deep");

  const missing = await toolGet(db, { id: "MMR-999" });
  expect(missing.isError).toBe(true);
  expect(textOf(missing)).toContain("error:");
});

test("status tool returns the rollup", async () => {
  await createTask(db, { parentId: phaseId, title: "t1" });
  const phaseSeq = (
    await db.selectFrom("node").select("seq").where("id", "=", phaseId).executeTakeFirstOrThrow()
  ).seq;
  const result = await toolStatus(db, { id: `MMR-${String(phaseSeq)}` });
  const parsed = JSON.parse(textOf(result)) as {
    state: string;
    distribution: Record<string, number>;
  };
  expect(parsed.state).toBe("ready");
  expect(parsed.distribution).toEqual({ ready: 1 });
});
