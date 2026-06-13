import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Server } from "bun";
import {
  completeTask,
  createInitiative,
  createPhase,
  createProject,
  createTask,
  findNodeByRef,
} from "../core";
import type { Db } from "../core";
import { createTestDb } from "../db/testing";
import { createServer } from "./server";

/**
 * The resource envelope end-to-end: a real server on an ephemeral loopback
 * port over a real in-memory DB — requests exercise routing, parsing, the
 * envelope, status mapping, and CORS exactly as a UI would.
 */

let db: Db;
let server: Server<undefined>;
let base: string;
let phaseRef: string;
let initiativeRef: string;
let task1: string;
let task2: string;
let otherTask: string;

type Rec = Record<string, unknown>;

beforeEach(async () => {
  db = await createTestDb();
  const p = await createProject(db, { key: "MMR", name: "Mimir" });
  const init = await createInitiative(db, { projectId: p.id, title: "build" });
  initiativeRef = `MMR-${String(init.seq)}`;
  const phase = await createPhase(db, { parentId: init.id, title: "phase 4" });
  phaseRef = `MMR-${String(phase.seq)}`;
  const t1 = await createTask(db, { parentId: phase.id, title: "first" });
  task1 = `MMR-${String(t1.seq)}`;
  const t2 = await createTask(db, { parentId: phase.id, title: "second", priority: "p1" });
  task2 = `MMR-${String(t2.seq)}`;

  const other = await createProject(db, { key: "NRN", name: "Norn" });
  const otherInit = await createInitiative(db, { projectId: other.id, title: "other" });
  const otherPhase = await createPhase(db, { parentId: otherInit.id, title: "op" });
  const ot = await createTask(db, { parentId: otherPhase.id, title: "elsewhere" });
  otherTask = `NRN-${String(ot.seq)}`;

  server = createServer(db, { port: 0, version: "0.0.0-test" });
  base = `http://127.0.0.1:${String(server.port)}`;
});

afterEach(async () => {
  await server.stop(true);
  await db.destroy();
});

const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { headers });

const send = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const parse = async (res: Response): Promise<Rec> => JSON.parse(await res.text()) as Rec;

const errorCode = (body: Rec): string => (body.error as { code: string }).code;

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

test("GET /api/health reports ok and the serving version", async () => {
  const res = await get("/api/health");
  expect(res.status).toBe(200);
  expect(await parse(res)).toEqual({ status: "ok", version: "0.0.0-test" });
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

test("GET /api/projects lists every project with its rollup", async () => {
  const res = await get("/api/projects");
  expect(res.status).toBe(200);
  const body = await parse(res);
  expect(body.total).toBe(2);
  const items = body.items as Rec[];
  expect(items.map((p) => p.id)).toEqual(["MMR", "NRN"]);
  expect(items[0]?.distribution).toBeDefined();
});

test("POST /api/projects creates and echoes the project record; duplicate keys conflict", async () => {
  const created = await send("POST", "/api/projects", { key: "ZZZ", name: "zed" });
  expect(created.status).toBe(201);
  expect((await parse(created)).id).toBe("ZZZ");

  const dup = await send("POST", "/api/projects", { key: "MMR", name: "again" });
  expect(dup.status).toBe(409);
});

test("GET /api/projects/:key returns the project record; a node ref is rejected", async () => {
  const res = await get("/api/projects/MMR");
  expect(res.status).toBe(200);
  const body = await parse(res);
  expect(body.type).toBe("project");
  expect(body.children).toBeDefined();

  const wrong = await get(`/api/projects/${task1}`);
  expect(wrong.status).toBe(400);
});

test("GET /api/projects/:key/tree nests the full hierarchy in board order", async () => {
  // Move task2 to the top of the rank order; the tree must reflect it positionally.
  await send("POST", `/api/nodes/${task2}/reorder`, { position: "top" });

  const res = await get("/api/projects/MMR/tree");
  expect(res.status).toBe(200);
  const root = await parse(res);
  expect(root.id).toBe("MMR");
  const initiatives = root.children as Rec[];
  expect(initiatives.map((n) => n.id)).toEqual([initiativeRef]);
  const phases = initiatives[0]?.children as Rec[];
  expect(phases.map((n) => n.id)).toEqual([phaseRef]);
  const tasks = phases[0]?.children as Rec[];
  expect(tasks.map((n) => n.id)).toEqual([task2, task1]);
  // Rank is array order, never a field; verdicts ride every record.
  expect(tasks[0]).not.toContainKey("rank");
  expect(tasks[0]?.verdicts).toEqual({ stale: false, blocking: false, orphaned: false });
});

test("GET /api/projects/:key/tree 404s on an unknown project", async () => {
  const res = await get("/api/projects/NOPE/tree");
  expect(res.status).toBe(404);
  expect(errorCode(await parse(res))).toBe("not_found");
});

// ---------------------------------------------------------------------------
// Nodes — collection
// ---------------------------------------------------------------------------

test("GET /api/nodes is cross-project and includes containers by default", async () => {
  const body = await parse(await get("/api/nodes"));
  const ids = (body.items as Rec[]).map((n) => n.id);
  expect(ids).toContain(task1);
  expect(ids).toContain(otherTask);
  expect(ids).toContain(phaseRef);
  expect(ids).toContain(initiativeRef);
});

test("GET /api/nodes?type= and ?project= narrow the selection", async () => {
  const tasks = await parse(await get("/api/nodes?type=task"));
  const taskIds = (tasks.items as Rec[]).map((n) => n.id);
  expect(taskIds).toContain(task1);
  expect(taskIds).not.toContain(phaseRef);

  const scoped = await parse(await get("/api/nodes?project=NRN"));
  const scopedIds = (scoped.items as Rec[]).map((n) => n.id);
  expect(scopedIds).toContain(otherTask);
  expect(scopedIds).not.toContain(task1);
});

test("GET /api/nodes?status= selects the universe; terminal tasks appear under all", async () => {
  await send("POST", `/api/nodes/${task1}/done`);

  const live = await parse(await get("/api/nodes?type=task"));
  expect((live.items as Rec[]).map((n) => n.id)).not.toContain(task1);

  const all = await parse(await get("/api/nodes?type=task&status=all"));
  expect((all.items as Rec[]).map((n) => n.id)).toContain(task1);

  const done = await parse(await get("/api/nodes?type=task&status=done"));
  expect((done.items as Rec[]).map((n) => n.id)).toEqual([task1]);
});

test("a bad status value is a warning and an empty set, not an error", async () => {
  const res = await get("/api/nodes?status=bogus");
  expect(res.status).toBe(200);
  const body = await parse(res);
  expect(body.items).toEqual([]);
  const warnings = body.warnings as Rec[];
  expect(warnings[0]?.field).toBe("status");
  expect(warnings[0]?.expected).toContain("live");
});

test("field operators filter; a bad field is a structural 400", async () => {
  const p1 = await parse(await get("/api/nodes?eq=priority:p1"));
  expect((p1.items as Rec[]).map((n) => n.id)).toEqual([task2]);

  const bad = await get("/api/nodes?eq=bogus:x");
  expect(bad.status).toBe(400);
  expect(errorCode(await parse(bad))).toBe("validation");
});

test("an unknown verdict and a bad limit are structural 400s; limit truncates", async () => {
  expect((await get("/api/nodes?is=bogus")).status).toBe(400);
  expect((await get("/api/nodes?limit=zero")).status).toBe(400);

  const limited = await parse(await get("/api/nodes?type=task&limit=1"));
  expect((limited.items as Rec[]).length).toBe(1);
  expect(limited.total as number).toBeGreaterThan(1);
});

// ---------------------------------------------------------------------------
// Nodes — detail
// ---------------------------------------------------------------------------

test("GET /api/nodes/:id returns the full record: verdicts on, artifacts listed, no rank field", async () => {
  const body = await parse(await get(`/api/nodes/${task1}`));
  expect(body.id).toBe(task1);
  expect(body.verdicts).toEqual({ stale: false, blocking: false, orphaned: false });
  expect(body.tags).toEqual([]);
  expect(body.artifacts).toEqual([]);
  expect(body).not.toContainKey("rank");
});

test("GET /api/nodes/:id rejects project and artifact identities, 404s the unknown", async () => {
  const project = await get("/api/nodes/MMR");
  expect(project.status).toBe(400);
  const artifact = await get("/api/nodes/MMR-a1");
  expect(artifact.status).toBe(400);
  const missing = await get("/api/nodes/MMR-999");
  expect(missing.status).toBe(404);
});

// ---------------------------------------------------------------------------
// Writes — lifecycle, holds, dependencies, structure
// ---------------------------------------------------------------------------

test("lifecycle actions echo the full updated record; an illegal transition is refused", async () => {
  const started = await send("POST", `/api/nodes/${task1}/start`);
  expect(started.status).toBe(200);
  const record = await parse(started);
  expect(record.lifecycle).toBe("in_progress");
  expect(record.status).toBe("in_progress");

  // The core codes illegal transitions `validation` (Phase-3 vocabulary) → 400.
  const again = await send("POST", `/api/nodes/${task1}/start`);
  expect(again.status).toBe(400);
  expect(errorCode(await parse(again))).toBe("validation");

  const done = await parse(await send("POST", `/api/nodes/${task1}/done`));
  expect(done.lifecycle).toBe("done");

  const abandoned = await parse(
    await send("POST", `/api/nodes/${task2}/abandon`, { reason: "obsolete" }),
  );
  expect(abandoned.status).toBe("abandoned");
});

test("hold actions set and clear the overlay", async () => {
  const parked = await parse(await send("POST", `/api/nodes/${task1}/park`, { reason: "later" }));
  expect(parked.status).toBe("parked");
  expect(parked.hold_reason).toBe("later");
  const unparked = await parse(await send("POST", `/api/nodes/${task1}/unpark`));
  expect(unparked.status).toBe("ready");

  const blocked = await parse(await send("POST", `/api/nodes/${task1}/block`));
  expect(blocked.status).toBe("blocked");
  const unblocked = await parse(await send("POST", `/api/nodes/${task1}/unblock`));
  expect(unblocked.status).toBe("ready");
});

test("depend/undepend wire the graph and flip the derived word; a cycle is refused", async () => {
  const awaiting = await parse(await send("POST", `/api/nodes/${task2}/depend`, { on: task1 }));
  expect(awaiting.status).toBe("awaiting");
  const deps = awaiting.deps as { depends_on: { id: string }[] };
  expect(deps.depends_on.map((d) => d.id)).toEqual([task1]);

  const cycle = await send("POST", `/api/nodes/${task1}/depend`, { on: task2 });
  expect(cycle.status).toBe(400);

  const freed = await parse(await send("POST", `/api/nodes/${task2}/undepend`, { on: task1 }));
  expect(freed.status).toBe("ready");
});

test("move reparents; reorder accepts both spellings and requires a position", async () => {
  const moved = await parse(await send("POST", `/api/nodes/${task1}/move`, { to: initiativeRef }));
  expect(moved.parent).toBe(initiativeRef);

  expect((await send("POST", `/api/nodes/${task2}/reorder`, { position: "top" })).status).toBe(200);
  expect((await send("POST", `/api/nodes/${task2}/reorder`, { after: task1 })).status).toBe(200);
  expect((await send("POST", `/api/nodes/${task2}/reorder`, {})).status).toBe(400);
});

// ---------------------------------------------------------------------------
// Writes — update, annotations, tags, create, attach
// ---------------------------------------------------------------------------

test("PATCH /api/nodes/:id is exactly the dumb update; lifecycle through it is structural", async () => {
  const res = await send("PATCH", `/api/nodes/${task1}`, { title: "renamed", priority: "p0" });
  expect(res.status).toBe(200);
  const body = await parse(res);
  expect(body.title).toBe("renamed");
  expect(body.priority).toBe("p0");

  const illegal = await send("PATCH", `/api/nodes/${task1}`, { lifecycle: "done" });
  expect(illegal.status).toBe(400);
  expect(errorCode(await parse(illegal))).toBe("validation");
});

test("annotations: POST appends (201), GET lists the sub-resource", async () => {
  const created = await send("POST", `/api/nodes/${task1}/annotations`, { content: "a note" });
  expect(created.status).toBe(201);

  const listed = await parse(await get(`/api/nodes/${task1}/annotations`));
  expect(listed.total).toBe(1);
  expect((listed.items as Rec[])[0]?.content).toBe("a note");
});

test("tags: PUT applies (idempotently, with a note), DELETE removes", async () => {
  const tagged = await parse(await send("PUT", `/api/nodes/${task1}/tags/urgent`, { note: "why" }));
  const tags = tagged.tags as { tag: string; note: string | null }[];
  expect(tags.map((t) => t.tag)).toEqual(["urgent"]);
  expect(tags[0]?.note).toBe("why");

  const untagged = await parse(await send("DELETE", `/api/nodes/${task1}/tags/urgent`));
  expect(untagged.tags).toEqual([]);
});

test("POST /api/nodes creates initiatives, phases, and tasks; bad types and parents are rejected", async () => {
  const init = await send("POST", "/api/nodes", {
    type: "initiative",
    parent: "NRN",
    title: "grow",
  });
  expect(init.status).toBe(201);

  const task = await send("POST", "/api/nodes", {
    type: "task",
    parent: phaseRef,
    title: "new work",
    priority: "p2",
    tags: ["api"],
  });
  expect(task.status).toBe(201);
  const record = await parse(task);
  expect(record.priority).toBe("p2");
  expect((record.tags as { tag: string }[]).map((t) => t.tag)).toEqual(["api"]);

  expect(
    (await send("POST", "/api/nodes", { type: "project", parent: "x", title: "t" })).status,
  ).toBe(400);
  expect(
    (await send("POST", "/api/nodes", { type: "task", parent: "MMR", title: "t" })).status,
  ).toBe(400);
});

test("artifacts: POST freezes onto the node (201), GET returns content; cross-project links refused", async () => {
  const created = await send("POST", `/api/nodes/${task1}/artifacts`, {
    title: "spec",
    content: "# Spec\nbody",
    links: [task2],
  });
  expect(created.status).toBe(201);
  const artifact = await parse(created);
  expect(artifact.id).toBe("MMR-a1");
  expect(artifact.links).toEqual([task1, task2]);

  const fetched = await parse(await get("/api/artifacts/MMR-a1"));
  expect(fetched.content).toBe("# Spec\nbody");
  expect((await get("/api/artifacts/MMR-a9")).status).toBe(404);

  const crossed = await send("POST", `/api/nodes/${task1}/artifacts`, {
    title: "x",
    content: "y",
    links: [otherTask],
  });
  expect(crossed.status).toBe(400);
});

test("PATCH /api/artifacts/:id retitles; content frozen; unknown fields and blank titles 400 (MMR-40)", async () => {
  await send("POST", `/api/nodes/${task1}/artifacts`, { title: "wrong", content: "# body" });

  const patched = await send("PATCH", "/api/artifacts/MMR-a1", { title: "right" });
  expect(patched.status).toBe(200);
  const echo = await parse(patched);
  expect(echo.title).toBe("right");
  expect(echo.content).toBe("# body");

  // content is frozen — not a patchable field
  expect((await send("PATCH", "/api/artifacts/MMR-a1", { content: "new" })).status).toBe(400);
  // blank title is validation
  expect((await send("PATCH", "/api/artifacts/MMR-a1", { title: " " })).status).toBe(400);
  // unknown artifact / node token on the artifact route
  expect((await send("PATCH", "/api/artifacts/MMR-a9", { title: "x" })).status).toBe(404);
  expect((await send("PATCH", `/api/artifacts/${task1}`, { title: "x" })).status).toBe(404);
});

// ---------------------------------------------------------------------------
// Transitions feed
// ---------------------------------------------------------------------------

test("GET /api/transitions pages by cursor: resume returns only newer entries", async () => {
  await send("POST", `/api/nodes/${task1}/start`);
  await send("POST", `/api/nodes/${task1}/done`);

  const first = await parse(await get("/api/transitions"));
  const items = first.items as Rec[];
  expect(items.length).toBeGreaterThanOrEqual(2);
  expect(items[0]?.node).toBe(task1);
  const cursor = first.next_cursor as string;
  expect(cursor).toBeDefined();

  const caughtUp = await parse(await get(`/api/transitions?since=${cursor}`));
  expect(caughtUp.items).toEqual([]);
  expect(caughtUp).not.toContainKey("next_cursor");

  await send("POST", `/api/nodes/${task2}/park`);
  const delta = await parse(await get(`/api/transitions?since=${cursor}`));
  expect((delta.items as Rec[]).length).toBe(1);
  expect((delta.items as Rec[])[0]?.kind).toBe("hold");

  expect((await get("/api/transitions?since=banana")).status).toBe(400);
});

test("GET /api/transitions?limit= truncates in log order", async () => {
  await send("POST", `/api/nodes/${task1}/start`);
  await send("POST", `/api/nodes/${task1}/done`);
  const body = await parse(await get("/api/transitions?limit=1"));
  expect((body.items as Rec[]).length).toBe(1);
});

// ---------------------------------------------------------------------------
// Protocol: bodies, fallbacks, CORS
// ---------------------------------------------------------------------------

test("unknown body fields and malformed JSON are structural 400s", async () => {
  const unknown = await send("POST", `/api/nodes/${task1}/start`, { force: true });
  expect(unknown.status).toBe(400);

  const malformed = await fetch(`${base}/api/nodes/${task1}/park`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  expect(malformed.status).toBe(400);
});

test("unmatched routes get the 404 envelope", async () => {
  const res = await get("/api/bogus");
  expect(res.status).toBe(404);
  expect(errorCode(await parse(res))).toBe("not_found");
});

test("CORS: localhost dev origins are reflected, others get no grant", async () => {
  const preflight = await fetch(`${base}/api/nodes`, {
    method: "OPTIONS",
    headers: { origin: "http://localhost:5173" },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");

  const dev = await get("/api/nodes", { origin: "http://127.0.0.1:4000" });
  expect(dev.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:4000");

  const foreign = await get("/api/nodes", { origin: "https://evil.example" });
  expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
  expect(foreign.status).toBe(200);
});

// ---------------------------------------------------------------------------
// Derivation through the envelope
// ---------------------------------------------------------------------------

test("a prerequisite's terminal state frees the dependent through the API view", async () => {
  await send("POST", `/api/nodes/${task2}/depend`, { on: task1 });
  const prereq = await findNodeByRef(db, task1);
  if (prereq === undefined) throw new Error(`fixture: no node ${task1}`);
  await completeTask(db, prereq.id);

  const body = await parse(await get(`/api/nodes/${task2}`));
  expect(body.status).toBe("ready");
});
