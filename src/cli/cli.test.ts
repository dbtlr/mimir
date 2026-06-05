import { afterEach, beforeEach, expect, test } from "bun:test";
import { createInitiative, createPhase, createProject, createTask, notFound } from "../core";
import type { Db } from "../core";
import { createTestDb } from "../db/testing";
import { UsageError, exitCodeFor, renderError } from "./errors";
import { runCli } from "./run";
import { fakeIo } from "./testing";

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

test("no command prints help and exits 0", async () => {
  const io = fakeIo(true);
  expect(await runCli([], db, io)).toBe(0);
  expect(io.out.join("")).toContain("usage: mimir");
});

test("unknown command exits 2 with an error", async () => {
  const io = fakeIo(true);
  expect(await runCli(["frobnicate"], db, io)).toBe(2);
  expect(io.err.join("")).toContain("unknown command");
  expect(io.out).toHaveLength(0);
});

test("next --format json lists ready tasks (count-led envelope)", async () => {
  await createTask(db, { parentId: phaseId, title: "first", priority: "p1" });
  const io = fakeIo();
  expect(await runCli(["next", "--scope", "MMR", "--format", "json"], db, io)).toBe(0);
  const parsed = JSON.parse(io.out.join("")) as { total: number; tasks: { title: string }[] };
  expect(parsed.total).toBe(1);
  expect(parsed.tasks[0]?.title).toBe("first");
});

test("next default format is ids when piped, table when TTY", async () => {
  const t = await createTask(db, { parentId: phaseId, title: "x" });
  const piped = fakeIo(false);
  await runCli(["next", "--scope", "MMR"], db, piped);
  expect(piped.out.join("")).toBe(`MMR-${String(t.seq)}`);

  const tty = fakeIo(true);
  await runCli(["next", "--scope", "MMR"], db, tty);
  const text = tty.out.join("");
  expect(text).toContain("1 task");
  expect(text).toContain(`MMR-${String(t.seq)}`);
  expect(text).toContain("ready");
});

test("get returns a record; a missing id exits non-zero", async () => {
  const t = await createTask(db, { parentId: phaseId, title: "deep" });
  const ok = fakeIo();
  expect(await runCli(["get", `MMR-${String(t.seq)}`, "--format", "json"], db, ok)).toBe(0);
  expect((JSON.parse(ok.out.join("")) as { title: string }).title).toBe("deep");

  const missing = fakeIo();
  expect(await runCli(["get", "MMR-999"], db, missing)).toBe(1);
  expect(missing.err.join("")).toContain("[err]");
  expect(missing.out).toHaveLength(0);
});

test("status reports the rollup of a non-leaf", async () => {
  await createTask(db, { parentId: phaseId, title: "t1" });
  const phase = await db
    .selectFrom("node")
    .select("seq")
    .where("id", "=", phaseId)
    .executeTakeFirstOrThrow();
  const io = fakeIo();
  expect(await runCli(["status", `MMR-${String(phase.seq)}`, "--format", "json"], db, io)).toBe(0);
  const parsed = JSON.parse(io.out.join("")) as { state: string };
  expect(parsed.state).toBe("ready");
});

test("an invalid flag value is a usage error → exit 2", async () => {
  const io = fakeIo();
  expect(await runCli(["next", "--priority", "p9"], db, io)).toBe(2);
  expect(io.err.join("")).toContain("invalid priority");
});

test("list --predicate selects the matching set", async () => {
  await createTask(db, { parentId: phaseId, title: "a" });
  const io = fakeIo();
  await runCli(["list", "--scope", "MMR", "--predicate", "ready", "--format", "ids"], db, io);
  expect(io.out.join("")).toContain("MMR-");
});

test("a bad --format value is a usage error → exit 2", async () => {
  const io = fakeIo(false);
  expect(await runCli(["next", "-f", "bogus"], db, io)).toBe(2);
  expect(io.out).toHaveLength(0);
});

test("renderError + exitCodeFor: json format produces structured envelope", () => {
  const err = notFound("no node MMR-9", "hint text");
  const io = fakeIo(true);
  renderError(err, "json", io);
  const parsed = JSON.parse(io.err.join("")) as {
    error: { code: string; message: string; hint: string };
  };
  expect(parsed.error.code).toBe("not_found");
  expect(parsed.error.message).toBe("no node MMR-9");
  expect(parsed.error.hint).toBe("hint text");
});

test("renderError: jsonl format produces same structured envelope as json", () => {
  const err = notFound("no node MMR-9", "hint text");
  const io = fakeIo(true);
  renderError(err, "jsonl", io);
  const parsed = JSON.parse(io.err.join("")) as {
    error: { code: string; message: string; hint: string };
  };
  expect(parsed.error.code).toBe("not_found");
  expect(parsed.error.message).toBe("no node MMR-9");
  expect(parsed.error.hint).toBe("hint text");
});

test("renderError + exitCodeFor: records format produces [err] line and note: line (plain)", () => {
  const err = notFound("no node MMR-9", "hint text");
  const io = fakeIo(false);
  renderError(err, "records", io);
  const output = io.err.join("\n");
  expect(output).toContain("[err]");
  expect(output).toContain("note:");
});

test("exitCodeFor returns 1 for MimirError and 2 for UsageError", () => {
  const mimirErr = notFound("no node MMR-9");
  const usageErr = new UsageError("bad invocation");
  expect(exitCodeFor(mimirErr)).toBe(1);
  expect(exitCodeFor(usageErr)).toBe(2);
});
