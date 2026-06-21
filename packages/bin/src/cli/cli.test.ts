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
  expect(await runCli([], () => db, io)).toBe(0);
  expect(io.out.join("")).toContain("usage: mimir");
});

test("unknown command exits 2 with an error", async () => {
  const io = fakeIo(true);
  expect(await runCli(["frobnicate"], () => db, io)).toBe(2);
  expect(io.err.join("")).toContain("unknown command");
  expect(io.out).toHaveLength(0);
});

test("help, usage errors, and unknown commands never acquire the store (MMR-39)", async () => {
  // The provider throws if asked: these paths must complete without it.
  const neverDb = (): Db => {
    throw new Error("store acquired on a data-free path");
  };
  expect(await runCli([], neverDb, fakeIo(true))).toBe(0);
  expect(await runCli(["--help"], neverDb, fakeIo(true))).toBe(0);
  expect(await runCli(["frobnicate"], neverDb, fakeIo(true))).toBe(2);
});

test("next --format json lists ready tasks (count-led envelope)", async () => {
  await createTask(db, { parentId: phaseId, title: "first", priority: "p1" });
  const io = fakeIo();
  expect(await runCli(["next", "--scope", "MMR", "--format", "json"], () => db, io)).toBe(0);
  const parsed = JSON.parse(io.out.join("")) as { total: number; tasks: { title: string }[] };
  expect(parsed.total).toBe(1);
  expect(parsed.tasks[0]?.title).toBe("first");
});

test("next default is the informative table view whether piped or TTY (MMR-87)", async () => {
  const t = await createTask(db, { parentId: phaseId, title: "x" });
  const id = `MMR-${String(t.seq)}`;

  // Piped (non-TTY): the same informative table content, not a bare id.
  const piped = fakeIo(false);
  await runCli(["next", "--scope", "MMR"], () => db, piped);
  const pipedText = piped.out.join("");
  expect(pipedText).toContain("1 task");
  expect(pipedText).toContain(id);
  expect(pipedText).toContain("ready");
  expect(pipedText).not.toBe(id);

  // TTY: identical information (decoration differs, content does not).
  const tty = fakeIo(true);
  await runCli(["next", "--scope", "MMR"], () => db, tty);
  const ttyText = tty.out.join("");
  expect(ttyText).toContain("1 task");
  expect(ttyText).toContain(id);
  expect(ttyText).toContain("ready");

  // Bare ids only on explicit -f ids (the composable pipeline opt-in).
  const ids = fakeIo(false);
  await runCli(["next", "--scope", "MMR", "-f", "ids"], () => db, ids);
  expect(ids.out.join("")).toBe(id);
});

test("list piped default is the table view, not bare ids (MMR-87)", async () => {
  await createTask(db, { parentId: phaseId, title: "alpha" });
  const piped = fakeIo(false);
  await runCli(["list", "--scope", "MMR", "--status", "ready"], () => db, piped);
  const text = piped.out.join("");
  expect(text).toContain("task");
  expect(text).toContain("alpha");
  expect(text).toContain("MMR-");
});

test("get returns a record; a missing id exits non-zero", async () => {
  const t = await createTask(db, { parentId: phaseId, title: "deep" });
  const ok = fakeIo();
  expect(await runCli(["get", `MMR-${String(t.seq)}`, "--format", "json"], () => db, ok)).toBe(0);
  expect((JSON.parse(ok.out.join("")) as { title: string }).title).toBe("deep");

  const missing = fakeIo();
  expect(await runCli(["get", "MMR-999"], () => db, missing)).toBe(1);
  expect(missing.err.join("")).toContain("[err]");
  expect(missing.out).toHaveLength(0);
});

test("get piped default is the records view, not a bare id (MMR-87)", async () => {
  const t = await createTask(db, { parentId: phaseId, title: "deep" });
  const id = `MMR-${String(t.seq)}`;

  const piped = fakeIo(false);
  await runCli(["get", id], () => db, piped);
  const text = piped.out.join("");
  expect(text).toContain(id);
  expect(text).toContain("title");
  expect(text).toContain("deep");
  expect(text).toContain("status");
  expect(text).not.toBe(id);

  // ids still available explicitly.
  const ids = fakeIo(false);
  await runCli(["get", id, "-f", "ids"], () => db, ids);
  expect(ids.out.join("")).toBe(id);
});

test("status reports the rollup of a non-leaf", async () => {
  await createTask(db, { parentId: phaseId, title: "t1" });
  const phase = await db
    .selectFrom("node")
    .select("seq")
    .where("id", "=", phaseId)
    .executeTakeFirstOrThrow();
  const io = fakeIo();
  expect(
    await runCli(["status", `MMR-${String(phase.seq)}`, "--format", "json"], () => db, io),
  ).toBe(0);
  const parsed = JSON.parse(io.out.join("")) as { status: string };
  expect(parsed.status).toBe("ready");
});

test("an invalid flag value is a usage error → exit 2", async () => {
  const io = fakeIo();
  expect(await runCli(["next", "--priority", "p9"], () => db, io)).toBe(2);
  expect(io.err.join("")).toContain("invalid priority");
});

test("list --status selects the matching universe", async () => {
  await createTask(db, { parentId: phaseId, title: "a" });
  const io = fakeIo();
  await runCli(["list", "--scope", "MMR", "--status", "ready", "--format", "ids"], () => db, io);
  expect(io.out.join("")).toContain("MMR-");
});

test("--predicate is gone — unknown flag is a usage error", async () => {
  const io = fakeIo();
  expect(await runCli(["list", "--predicate", "ready"], () => db, io)).toBe(2);
});

test("a bad --format value is a usage error → exit 2", async () => {
  const io = fakeIo(false);
  expect(await runCli(["next", "-f", "bogus"], () => db, io)).toBe(2);
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

// addressability (MMR-32): the full id grammar at the CLI surface

test("get on a bare KEY renders the whole-project view", async () => {
  const io = fakeIo(false);
  expect(await runCli(["get", "MMR", "-f", "json"], () => db, io)).toBe(0);
  const parsed = JSON.parse(io.out.join("")) as { id: string; type: string };
  expect(parsed.id).toBe("MMR");
  expect(parsed.type).toBe("project");
});

test("a task verb on a project KEY is a behavioral error (validation → exit 1)", async () => {
  const io = fakeIo(false);
  expect(await runCli(["done", "MMR"], () => db, io)).toBe(1);
  expect(io.err.join("")).toContain("MMR is a project, not a task");
  expect(io.out).toHaveLength(0);
});

test("attach echoes KEY-aN and get reads the artifact back", async () => {
  const t = await createTask(db, { parentId: phaseId, title: "t" });
  const tmp = `${process.env.TMPDIR ?? "/tmp"}/mimir-aid.md`;
  await Bun.write(tmp, "# body\n");
  // -f ids is the composable id-capture form the skill teaches (ID=$(… -f ids)).
  const io = fakeIo(false);
  expect(
    await runCli(["attach", `MMR-${String(t.seq)}`, "--file", tmp, "-f", "ids"], () => db, io),
  ).toBe(0);
  expect(io.out.join("")).toBe("MMR-a1");

  // The default piped echo is the human confirmation line, carrying the id (MMR-87).
  const conf = fakeIo(false);
  await runCli(["attach", `MMR-${String(t.seq)}`, "--file", tmp], () => db, conf);
  expect(conf.out.join("")).toContain("MMR-a");

  const read = fakeIo(false);
  expect(await runCli(["get", "MMR-a1", "-f", "json"], () => db, read)).toBe(0);
  const parsed = JSON.parse(read.out.join("")) as { id: string; links: string[] };
  expect(parsed.id).toBe("MMR-a1");
  expect(parsed.links).toEqual([`MMR-${String(t.seq)}`]);
});

test("a task verb on an artifact id is a behavioral error", async () => {
  const io = fakeIo(false);
  expect(await runCli(["start", "MMR-a1"], () => db, io)).toBe(1);
  expect(io.err.join("")).toContain("MMR-a1 is an artifact, not a task");
});

// tag write surface (MMR-31)

test("tag and untag round-trip through the CLI", async () => {
  const t = await createTask(db, { parentId: phaseId, title: "t" });
  const ref = `MMR-${String(t.seq)}`;
  const io = fakeIo(false);
  expect(await runCli(["tag", `${ref},MMR`, "spec", "v2", "-f", "json"], () => db, io)).toBe(0);
  expect(JSON.parse(io.out.join(""))).toEqual({
    tagged: { ids: [ref, "MMR"], tags: ["spec", "v2"] },
  });

  const read = fakeIo(false);
  await runCli(["get", ref, "-f", "json"], () => db, read);
  const view = JSON.parse(read.out.join("")) as { tags: { tag: string }[] };
  expect(view.tags.map((x) => x.tag)).toEqual(["spec", "v2"]);

  const rm = fakeIo(false);
  expect(await runCli(["untag", ref, "v2", "-f", "json"], () => db, rm)).toBe(0);
  const reread = fakeIo(false);
  await runCli(["get", ref, "-f", "json"], () => db, reread);
  const after = JSON.parse(reread.out.join("")) as { tags: { tag: string }[] };
  expect(after.tags.map((x) => x.tag)).toEqual(["spec"]);
});

test("tag without tags is a usage error", async () => {
  const io = fakeIo(false);
  expect(await runCli(["tag", "MMR-1"], () => db, io)).toBe(2);
  expect(io.err.join("")).toContain("at least one tag");
});

test("create task --tag applies creation-time tags", async () => {
  const io = fakeIo(false);
  const phase = await db
    .selectFrom("node")
    .select("seq")
    .where("id", "=", phaseId)
    .executeTakeFirstOrThrow();
  const code = await runCli(
    [
      "create",
      "task",
      "tt",
      "--parent",
      `MMR-${String(phase.seq)}`,
      "--tag",
      "spec",
      "--tag",
      "v2",
      "-f",
      "json",
    ],
    () => db,
    io,
  );
  expect(code).toBe(0);
  const echoed = JSON.parse(io.out.join("")) as { id: string };
  const read = fakeIo(false);
  await runCli(["get", echoed.id, "-f", "json"], () => db, read);
  const view = JSON.parse(read.out.join("")) as { tags: { tag: string }[] };
  expect(view.tags.map((x) => x.tag)).toEqual(["spec", "v2"]);
});

// query surface v2 (MMR-33)

test("a value miss warns on stderr and exits 0 with an empty set", async () => {
  await createTask(db, { parentId: phaseId, title: "a", priority: "p1" });
  const io = fakeIo(true);
  const code = await runCli(
    ["list", "--scope", "MMR", "--eq", "priority:p9", "--ascii"],
    () => db,
    io,
  );
  expect(code).toBe(0);
  expect(io.out.join("")).toContain("0 tasks");
  expect(io.err.join("\n")).toContain("[warn] p9 is not a priority");
  expect(io.err.join("\n")).toContain("expected p0, p1, p2, p3");
});

test("a value miss in json format emits the warning envelope on stderr", async () => {
  const io = fakeIo(false);
  const code = await runCli(["list", "--eq", "priority:p9", "-f", "json"], () => db, io);
  expect(code).toBe(0);
  const warning = JSON.parse(io.err.join("")) as {
    warning: { code: string; field: string; value: string; expected: string[] };
  };
  expect(warning.warning.code).toBe("no_match_value");
  expect(warning.warning.field).toBe("priority");
  expect(warning.warning.expected).toEqual(["p0", "p1", "p2", "p3"]);
  // stdout still carries the (empty) result
  expect((JSON.parse(io.out.join("")) as { total: number }).total).toBe(0);
});

test("an unknown field is a usage error (exit 2)", async () => {
  const io = fakeIo(false);
  expect(await runCli(["list", "--eq", "bogus:x"], () => db, io)).toBe(2);
  expect(io.err.join("")).toContain("unknown field bogus");
});

test("a date op on a non-date field is a usage error (exit 2)", async () => {
  const io = fakeIo(false);
  expect(await runCli(["list", "--before", "priority:p1"], () => db, io)).toBe(2);
});

test("--is/--not-is select verdicts; --status picks the universe", async () => {
  const a = await createTask(db, { parentId: phaseId, title: "a" });
  const b = await createTask(db, { parentId: phaseId, title: "b" });
  const aRef = `MMR-${String(a.seq)}`;
  const bRef = `MMR-${String(b.seq)}`;
  await runCli(["depend", bRef, "--on", aRef], () => db, fakeIo(false));

  const blocking = fakeIo(false);
  await runCli(["list", "-s", "MMR", "--is", "blocking", "-f", "ids"], () => db, blocking);
  expect(blocking.out.join("")).toBe(aRef);

  const awaiting = fakeIo(false);
  await runCli(["list", "-s", "MMR", "--status", "awaiting", "-f", "ids"], () => db, awaiting);
  expect(awaiting.out.join("")).toBe(bRef);

  await runCli(["done", aRef], () => db, fakeIo(false));
  const terminal = fakeIo(false);
  await runCli(["list", "-s", "MMR", "--status", "terminal", "-f", "ids"], () => db, terminal);
  expect(terminal.out.join("")).toBe(aRef);
});

test("depend --on still works as a write flag alongside the date op", async () => {
  const a = await createTask(db, { parentId: phaseId, title: "a" });
  const b = await createTask(db, { parentId: phaseId, title: "b" });
  const io = fakeIo(false);
  const code = await runCli(
    ["depend", `MMR-${String(b.seq)}`, "--on", `MMR-${String(a.seq)}`, "-f", "json"],
    () => db,
    io,
  );
  expect(code).toBe(0);
  expect((JSON.parse(io.out.join("")) as { status: string }).status).toBe("awaiting");
});

// artifact title + readback (MMR-34)

test("attach defaults title from the file basename; --title overrides; --tag classifies", async () => {
  const t = await createTask(db, { parentId: phaseId, title: "t" });
  const ref = `MMR-${String(t.seq)}`;
  const tmp = `${process.env.TMPDIR ?? "/tmp"}/dogfood-plan.md`;
  await Bun.write(tmp, "# body\n");

  const io = fakeIo(false);
  await runCli(["attach", ref, "--file", tmp, "--tag", "spec"], () => db, io);
  const read = fakeIo(false);
  await runCli(["get", "MMR-a1", "-f", "json"], () => db, read);
  const detail = JSON.parse(read.out.join("")) as { title: string; tags: string[] };
  expect(detail.title).toBe("dogfood-plan.md");
  expect(detail.tags).toEqual(["spec"]);

  const io2 = fakeIo(false);
  await runCli(["attach", ref, "--file", tmp, "--title", "the plan"], () => db, io2);
  const read2 = fakeIo(false);
  await runCli(["get", "MMR-a2", "-f", "json"], () => db, read2);
  expect((JSON.parse(read2.out.join("")) as { title: string }).title).toBe("the plan");
});

test("attach from stdin without --title is a usage error", async () => {
  const t = await createTask(db, { parentId: phaseId, title: "t" });
  const io = fakeIo(true); // TTY → no stdin content either, but flag check comes after content
  const code = await runCli(["attach", `MMR-${String(t.seq)}`], () => db, io);
  expect(code).toBe(2);
});

test("get KEY-aN --col content returns the frozen body", async () => {
  const t = await createTask(db, { parentId: phaseId, title: "t" });
  const tmp = `${process.env.TMPDIR ?? "/tmp"}/body.md`;
  await Bun.write(tmp, "# the frozen body\n");
  await runCli(["attach", `MMR-${String(t.seq)}`, "--file", tmp], () => db, fakeIo(false));

  const bare = fakeIo(false);
  await runCli(["get", "MMR-a1", "-f", "json"], () => db, bare);
  expect(JSON.parse(bare.out.join("")) as object).not.toHaveProperty("content");

  const withContent = fakeIo(false);
  await runCli(["get", "MMR-a1", "--col", "content", "-f", "json"], () => db, withContent);
  const parsed = JSON.parse(withContent.out.join("")) as { content: string };
  expect(parsed.content).toBe("# the frozen body\n");
});

// create project positional name (MMR-35)

test("create project accepts a positional name", async () => {
  const io = fakeIo(false);
  const code = await runCli(
    ["create", "project", "Other Tool", "--key", "OTH", "-y", "-f", "json"],
    () => db,
    io,
  );
  expect(code).toBe(0);
  expect(JSON.parse(io.out.join(""))).toEqual({ project: { key: "OTH", name: "Other Tool" } });
});

test("create project still accepts --name and errors without either", async () => {
  const io = fakeIo(false);
  expect(
    await runCli(["create", "project", "--key", "FLG", "--name", "Flagged", "-y"], () => db, io),
  ).toBe(0);
  const bad = fakeIo(false);
  expect(await runCli(["create", "project", "--key", "BAD", "-y"], () => db, bad)).toBe(2);
  expect(bad.err.join("")).toContain("requires a name");
});

// flat --col vocabulary (MMR-38)

// self-update flag wiring (MMR-57)

test("self-update --tag requires a value (usage error, exit 2)", async () => {
  const io = fakeIo();
  const code = await runCli(
    ["self-update", "--tag"],
    () => {
      throw new Error("db must not open");
    },
    io,
  );
  expect(code).toBe(2);
});

test("--col takes flat column names; the dot form is a usage error", async () => {
  const t = await createTask(db, { parentId: phaseId, title: "t" });
  const ref = `MMR-${String(t.seq)}`;
  const io = fakeIo(false);
  await runCli(["get", ref, "--col", "history", "-f", "json"], () => db, io);
  const view = JSON.parse(io.out.join("")) as { history: unknown[] };
  expect(Array.isArray(view.history)).toBe(true);

  const dotted = fakeIo(false);
  expect(await runCli(["get", ref, "--col", ".history"], () => db, dotted)).toBe(2);
  expect(dotted.err.join("")).toContain("columns are flat now");

  const unknown = fakeIo(false);
  expect(await runCli(["get", ref, "--col", "bogus"], () => db, unknown)).toBe(2);
  expect(unknown.err.join("")).toContain("unknown column: bogus");
});

// --type removal (MMR-94)

test("list --eq type:phase filters to phases only", async () => {
  // The db has one phase (phaseId) and a task; ensure --eq type:phase returns phase but not tasks.
  const t = await createTask(db, { parentId: phaseId, title: "a task" });
  const io = fakeIo(false);
  const code = await runCli(
    ["list", "--scope", "MMR", "--status", "all", "--eq", "type:phase", "-f", "ids"],
    () => db,
    io,
  );
  expect(code).toBe(0);
  const out = io.out.join("");
  // Should contain a phase id (MMR-N) but not the task id
  expect(out).toContain("MMR-");
  expect(out).not.toContain(`MMR-${String(t.seq)}`);
});

test("--type is now an unknown option → rejected with exit 2 (MMR-94)", async () => {
  const io = fakeIo(false);
  const code = await runCli(["list", "--type", "phase"], () => db, io);
  expect(code).toBe(2);
});
