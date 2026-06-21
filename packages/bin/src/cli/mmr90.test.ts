/**
 * MMR-90 — Self-orienting entity responses: child titles, rollup signpost,
 * onward TTY hint, and `mimir tree <id>`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createInitiative, createPhase, createProject, createTask, nodeTree } from "../core";
import type { Db } from "../core";
import { createTestDb } from "../db/testing";
import { runCli } from "./run";
import { fakeIo } from "./testing";

let db: Db;
let phaseId: number;
let phaseSeq: number;
let initSeq: number;

beforeEach(async () => {
  db = await createTestDb();
  const p = await createProject(db, { key: "MMR", name: "Mimir" });
  const init = await createInitiative(db, { projectId: p.id, title: "The Initiative" });
  initSeq = init.seq;
  const phase = await createPhase(db, { parentId: init.id, title: "Phase One" });
  phaseId = phase.id;
  phaseSeq = phase.seq;
});
afterEach(async () => {
  await db.destroy();
});

// ─── Deliverable 1: Child titles ───────────────────────────────────────────

describe("NodeRef titles (deliverable 1)", () => {
  test("children refs carry the title alongside id+status", async () => {
    await createTask(db, { parentId: phaseId, title: "First task" });
    const io = fakeIo(false);
    await runCli(["get", `MMR-${String(phaseSeq)}`, "-f", "json"], () => db, io);
    const view = JSON.parse(io.out.join("")) as {
      children: { id: string; status: string; title: string }[];
    };
    expect(view.children).toHaveLength(1);
    expect(view.children[0]?.title).toBe("First task");
  });

  test("dependsOn/blocking refs carry the title", async () => {
    const a = await createTask(db, { parentId: phaseId, title: "Alpha" });
    const b = await createTask(db, { parentId: phaseId, title: "Beta" });
    const aRef = `MMR-${String(a.seq)}`;
    const bRef = `MMR-${String(b.seq)}`;
    await runCli(["depend", bRef, "--on", aRef], () => db, fakeIo(false));

    const ioA = fakeIo(false);
    await runCli(["get", aRef, "-f", "json"], () => db, ioA);
    const viewA = JSON.parse(ioA.out.join("")) as {
      deps: { blocking: { id: string; title: string }[] };
    };
    expect(viewA.deps.blocking[0]?.title).toBe("Beta");

    const ioB = fakeIo(false);
    await runCli(["get", bRef, "-f", "json"], () => db, ioB);
    const viewB = JSON.parse(ioB.out.join("")) as {
      deps: { depends_on: { id: string; title: string }[] };
    };
    expect(viewB.deps.depends_on[0]?.title).toBe("Alpha");
  });

  test("renderRecords shows title in children line", async () => {
    await createTask(db, { parentId: phaseId, title: "My Task" });
    const io = fakeIo(false);
    await runCli(["get", `MMR-${String(phaseSeq)}`, "-f", "records"], () => db, io);
    const text = io.out.join("");
    expect(text).toContain("My Task");
  });
});

// ─── Deliverable 2: Rollup signpost + TTY onward hint ───────────────────────

describe("Rollup signpost and TTY hint (deliverable 2)", () => {
  test("records for a container shows rollup signpost on TTY", async () => {
    await createTask(db, { parentId: phaseId, title: "t1" });
    await createTask(db, { parentId: phaseId, title: "t2" });
    const tty = fakeIo(true); // TTY
    await runCli(["get", `MMR-${String(phaseSeq)}`], () => db, tty);
    const text = tty.out.join("");
    expect(text).toMatch(/rollup/);
    expect(text).toMatch(/\d+ direct child/);
  });

  test("TTY records for a container includes onward hint pointing to mimir tree", async () => {
    await createTask(db, { parentId: phaseId, title: "t1" });
    const tty = fakeIo(true);
    await runCli(["get", `MMR-${String(phaseSeq)}`], () => db, tty);
    const text = tty.out.join("");
    expect(text).toContain("mimir tree");
  });

  test("structured json format has NO prose hint (machine contract)", async () => {
    await createTask(db, { parentId: phaseId, title: "t1" });
    const io = fakeIo(false);
    await runCli(["get", `MMR-${String(phaseSeq)}`, "-f", "json"], () => db, io);
    const text = io.out.join("");
    // Must not contain prose hint in JSON
    expect(text).not.toContain("mimir tree");
    // But must still contain the distribution data
    const view = JSON.parse(text) as { distribution: Record<string, number> };
    expect(view.distribution).toBeDefined();
  });

  test("jsonl format has NO prose hint (machine contract)", async () => {
    await createTask(db, { parentId: phaseId, title: "t1" });
    const io = fakeIo(false);
    await runCli(["get", `MMR-${String(phaseSeq)}`, "-f", "jsonl"], () => db, io);
    const text = io.out.join("");
    expect(text).not.toContain("mimir tree");
  });

  test("ids format has NO prose hint (machine contract)", async () => {
    await createTask(db, { parentId: phaseId, title: "t1" });
    const io = fakeIo(false);
    await runCli(["get", `MMR-${String(phaseSeq)}`, "-f", "ids"], () => db, io);
    const text = io.out.join("");
    expect(text).not.toContain("mimir tree");
    // ids format: just the id
    expect(text.trim()).toBe(`MMR-${String(phaseSeq)}`);
  });

  test("non-TTY records format has NO onward hint", async () => {
    await createTask(db, { parentId: phaseId, title: "t1" });
    const piped = fakeIo(false); // non-TTY
    await runCli(["get", `MMR-${String(phaseSeq)}`], () => db, piped);
    const text = piped.out.join("");
    // The records show data, but no hint prose
    expect(text).not.toContain("mimir tree");
  });

  test("leaf task records shows no rollup signpost", async () => {
    const t = await createTask(db, { parentId: phaseId, title: "leaf" });
    const tty = fakeIo(true);
    await runCli(["get", `MMR-${String(t.seq)}`], () => db, tty);
    const text = tty.out.join("");
    expect(text).not.toMatch(/rollup/);
    expect(text).not.toContain("mimir tree");
  });
});

// ─── Deliverable 3: mimir tree <id> ─────────────────────────────────────────

describe("mimir tree (deliverable 3)", () => {
  test("nodeTree can root at a project key", async () => {
    await createTask(db, { parentId: phaseId, title: "t1" });
    const tree = await nodeTree(db, "MMR");
    expect(tree.id).toBe("MMR");
    expect(tree.type).toBe("project");
    expect(tree.children.length).toBeGreaterThan(0);
  });

  test("nodeTree can root at any node id (mid-tree)", async () => {
    await createTask(db, { parentId: phaseId, title: "t1" });
    const tree = await nodeTree(db, `MMR-${String(initSeq)}`);
    expect(tree.id).toBe(`MMR-${String(initSeq)}`);
    expect(tree.children.length).toBeGreaterThan(0);
    // Should have phase as child, which has tasks under it
    const phase = tree.children.find((c) => c.id === `MMR-${String(phaseSeq)}`);
    expect(phase).toBeDefined();
    expect(phase?.children.length).toBe(1);
  });

  test("mimir tree CLI verb renders an indented hierarchy", async () => {
    await createTask(db, { parentId: phaseId, title: "leaf task" });
    const io = fakeIo(true);
    const code = await runCli(["tree", "MMR"], () => db, io);
    expect(code).toBe(0);
    const text = io.out.join("");
    expect(text).toContain("MMR");
    expect(text).toContain("Phase One");
    expect(text).toContain("leaf task");
    // Check indentation: children should be indented
    const lines = text.split("\n").filter((l) => l.length > 0);
    // The phase line should be indented (has leading spaces)
    const phaseLine = lines.find((l) => l.includes("Phase One"));
    expect(phaseLine).toBeDefined();
    expect(phaseLine).toMatch(/^\s+/);
  });

  test("mimir tree CLI verb with a mid-tree node id", async () => {
    await createTask(db, { parentId: phaseId, title: "leaf task" });
    const io = fakeIo(true);
    const code = await runCli(["tree", `MMR-${String(initSeq)}`], () => db, io);
    expect(code).toBe(0);
    const text = io.out.join("");
    expect(text).toContain("The Initiative");
    expect(text).toContain("Phase One");
    expect(text).toContain("leaf task");
  });

  test("mimir tree -f json emits a tree object", async () => {
    await createTask(db, { parentId: phaseId, title: "t1" });
    const io = fakeIo(false);
    const code = await runCli(["tree", "MMR", "-f", "json"], () => db, io);
    expect(code).toBe(0);
    const parsed = JSON.parse(io.out.join("")) as {
      id: string;
      children: { id: string; children: unknown[] }[];
    };
    expect(parsed.id).toBe("MMR");
    expect(Array.isArray(parsed.children)).toBe(true);
  });

  test("mimir tree missing id exits non-zero", async () => {
    const io = fakeIo(false);
    const code = await runCli(["tree", "MMR-999"], () => db, io);
    expect(code).toBe(1);
  });

  test("mimir tree without an id is a usage error", async () => {
    const io = fakeIo(false);
    const code = await runCli(["tree"], () => db, io);
    expect(code).toBe(2);
  });

  test("mimir tree --help shows usage text for tree verb", async () => {
    const io = fakeIo(true);
    // The global --help includes tree
    const code = await runCli(["--help"], () => db, io);
    expect(code).toBe(0);
    const text = io.out.join("");
    expect(text).toContain("tree");
  });
});
