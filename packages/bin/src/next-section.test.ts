import { afterEach, beforeEach, expect, test } from 'bun:test';

import type { Server } from 'bun';

import { runCli } from './cli/run';
import { fakeIo } from './cli/testing';
import {
  attachArtifact,
  createInitiative,
  createPhase,
  createProject,
  createTask,
  fileSeed,
  getNode,
  updateNode,
  updateProject,
} from './core';
import type { Store } from './core';
import type { DoctorDeps } from './doctor/commands';
import { cmdDoctor } from './doctor/commands';
import { diagnoseDoctor } from './doctor/diagnosis';
import { createServer } from './http/server';
import { toolUpdate } from './mcp/tools';
import { createTestStore, nodeIdOf, projectIdOf } from './testing/store';

/**
 * The owned `## Next` direction narrative (MMR-321, ADR 0026 Decision 2), end to
 * end over a real vault: the set → replace → clear → no-op cycle in the
 * document bytes, the container-only applicability refusals in each transport's
 * own voice, and an accept-AND-apply pin per transport (the MMR-315 gap — a
 * surface that advertises the field but never writes it).
 */

const NORN = Bun.which('norn') !== null;

let store: Store;
let closeStore: (() => Promise<void>) | undefined;
let readDocument: (path: string) => string;
let corruptDocument: (path: string, mutate: (raw: string) => string) => void;
let doctorDeps: DoctorDeps;
let server: Server<undefined>;
let base: string;
let projectId: string;
let initiativeRef: string;
let phaseRef: string;
let taskRef: string;
let seedRef: string;
let artifactRef: string;

beforeEach(async () => {
  if (!NORN) {
    return;
  }
  ({
    close: closeStore,
    corruptDocument,
    doctor: doctorDeps,
    readDocument,
    store,
  } = await createTestStore());
  await createProject(store, { key: 'MMR', name: 'Mimir' });
  projectId = await projectIdOf(store, 'MMR');
  const initiative = await createInitiative(store, { projectId, title: 'init' });
  initiativeRef = `MMR-${String(initiative.seq)}`;
  const phase = await createPhase(store, {
    parentId: await nodeIdOf(store, initiativeRef),
    title: 'phase',
  });
  phaseRef = `MMR-${String(phase.seq)}`;
  const task = await createTask(store, {
    parentId: await nodeIdOf(store, phaseRef),
    title: 'task',
  });
  taskRef = `MMR-${String(task.seq)}`;
  seedRef = (await fileSeed(store, { kind: 'idea', project: 'MMR', requester: null, title: 's' }))
    .id;
  artifactRef = (await attachArtifact(store, { content: 'frozen', projectId, title: 'note' }))
    .renderedId;
  server = createServer(store, { port: 0, version: '0.0.0-test' });
  base = `http://127.0.0.1:${String(server.port)}`;
});

afterEach(async () => {
  await server?.stop(true);
  await closeStore?.();
});

/** The `next` facet as a detail `get` projects it (absent when the section is). */
async function readNext(ref: string): Promise<string | undefined> {
  return (await getNode(store, ref)).next;
}

/** Run the CLI over the fixture store, asserting the exit code. */
async function cli(argv: string[], code = 0): Promise<string> {
  const io = fakeIo(false);
  expect(await runCli(argv, () => store, io)).toBe(code);
  return [...io.out, ...io.err].join('\n');
}

// ── The write cycle ────────────────────────────────────────────────────────

test.skipIf(!NORN)('set, replace, and clear re-author the whole section (MMR-321)', async () => {
  const id = await nodeIdOf(store, phaseRef);
  await updateNode(store, id, { next: 'Land the read path.' });
  expect(await readNext(phaseRef)).toBe('Land the read path.');
  // The section sits above `## History`, and its prose is the WHOLE body.
  const set = readDocument(`MMR/${phaseRef}.md`);
  expect(set).toContain('## Next\n\nLand the read path.\n## History');

  await updateNode(store, id, { next: 'Actually: revisit caching first.' });
  expect(await readNext(phaseRef)).toBe('Actually: revisit caching first.');
  // Replace, not append — the superseded sentence is gone, and there is exactly
  // one `## Next` heading.
  const replaced = readDocument(`MMR/${phaseRef}.md`);
  expect(replaced).not.toContain('Land the read path.');
  expect(replaced.split('## Next').length - 1).toBe(1);

  await updateNode(store, id, { next: '' });
  expect(await readNext(phaseRef)).toBeUndefined();
  // A clear removes the heading too — an empty section is never left behind.
  expect(readDocument(`MMR/${phaseRef}.md`)).not.toContain('## Next');
});

test.skipIf(!NORN)('a no-op re-author writes nothing at all (MMR-321)', async () => {
  const id = await nodeIdOf(store, phaseRef);
  await updateNode(store, id, { next: 'Hold the line.' });
  const before = readDocument(`MMR/${phaseRef}.md`);
  const stampBefore = (await getNode(store, phaseRef)).updatedAt;

  await updateNode(store, id, { next: 'Hold the line.' });
  // Byte-identical, stamp unmoved: `updated_at` drives the stale predicate, so a
  // re-author that changes nothing must not look like activity.
  expect(readDocument(`MMR/${phaseRef}.md`)).toBe(before);
  expect((await getNode(store, phaseRef)).updatedAt).toBe(stampBefore);
});

test.skipIf(!NORN)('multiline prose round-trips through the section codec (MMR-321)', async () => {
  const prose = 'First, the read path.\n\n- then caching\n- then the UI\n\n## not a heading';
  await updateNode(store, await nodeIdOf(store, initiativeRef), { next: prose });
  expect(await readNext(initiativeRef)).toBe(prose);
});

// ── Applicability ──────────────────────────────────────────────────────────

test.skipIf(!NORN)('a task refuses the direction narrative (MMR-321)', async () => {
  const out = await cli(['update', taskRef, '--direction', 'nope'], 1);
  expect(out).toContain('next applies only to phases and initiatives');
});

test.skipIf(!NORN)('a seed and an artifact refuse it in each voice (MMR-321)', async () => {
  const seedOut = await cli(['update', seedRef, '--direction', 'nope'], 2);
  expect(seedOut).toContain("--direction doesn't apply to a seed");
  const artifactOut = await cli(['update', artifactRef, '--direction', 'nope'], 1);
  expect(artifactOut).toContain("--direction doesn't apply to an artifact");

  const seedTool = await toolUpdate(store, { id: seedRef, next: 'nope' });
  expect(seedTool.isError).toBe(true);
  expect(seedTool.content[0]?.text).toContain('next do not apply to a seed');
  const artifactTool = await toolUpdate(store, { id: artifactRef, next: 'nope' });
  expect(artifactTool.isError).toBe(true);
  expect(artifactTool.content[0]?.text).toContain('next applies only to nodes');
});

// ── The hand-duplicated heading ────────────────────────────────────────────

/**
 * norn warn-OMITS an AMBIGUOUS `## Next` from `sections` exactly as it omits a
 * MISSING one, and its structured `section_failures` channel is byte-identical
 * for the two — only the human-readable note distinguishes them. So the section
 * read alone reports a duplicate as "no section", and a write that trusted that
 * would insert a THIRD copy on every run while a clear reported success having
 * removed nothing. The write path counts the anchors and refuses.
 */

/** Hand-edit a second `## Next` in ABOVE `## History`, as a careless merge would. */
function duplicateNextHeading(path: string): void {
  corruptDocument(path, (raw) => raw.replace('## History', '## Next\n\nsecond\n\n## History'));
}

/**
 * Hand-append a second `## Next` at END of file — after `## Annotations`, past
 * every seeded anchor. The other placement a careless edit produces, and the one
 * a plain `printf '\n## Next\n…' >> doc.md` makes; kept distinct from
 * {@link duplicateNextHeading} because the detector scans anchors rather than a
 * bounded section range, and only an EOF case proves it isn't range-bound.
 */
function appendDuplicateNextAtEof(path: string): void {
  corruptDocument(path, (raw) => `${raw}\n## Next\n\nsecond copy\n`);
}

test.skipIf(!NORN)('a duplicated ## Next refuses the set, writing nothing (MMR-321)', async () => {
  const id = await nodeIdOf(store, phaseRef);
  await updateNode(store, id, { next: 'first' });
  duplicateNextHeading(`MMR/${phaseRef}.md`);
  const before = readDocument(`MMR/${phaseRef}.md`);

  const out = await cli(['update', phaseRef, '--direction', 'third'], 1);
  expect(out).toContain("more than one '## Next' heading");
  expect(out).toContain('mimir doctor');
  // The pre-fix bug inserted a third section here.
  expect(readDocument(`MMR/${phaseRef}.md`)).toBe(before);
});

test.skipIf(!NORN)(
  'a duplicated ## Next refuses the clear rather than lying (MMR-321)',
  async () => {
    const id = await nodeIdOf(store, phaseRef);
    await updateNode(store, id, { next: 'first' });
    duplicateNextHeading(`MMR/${phaseRef}.md`);
    const before = readDocument(`MMR/${phaseRef}.md`);

    // The pre-fix bug echoed `updated (next)` at exit 0 having changed nothing.
    const out = await cli(['update', phaseRef, '--direction', ''], 1);
    expect(out).toContain("more than one '## Next' heading");
    expect(readDocument(`MMR/${phaseRef}.md`)).toBe(before);
  },
);

test.skipIf(!NORN)('mimir doctor names the duplicated ## Next heading (MMR-321)', async () => {
  await updateProject(store, projectId, { next: 'first' });
  duplicateNextHeading('MMR/MMR.md');

  const io = fakeIo();
  expect(await cmdDoctor(io, doctorDeps, 'json', 'MMR')).toBe(0);
  const findings = JSON.parse(io.out.join('')) as { code?: string; node?: string }[];
  const duplicate = findings.filter((f) => f.code === 'duplicate-next-section');
  expect(duplicate).toHaveLength(1);
  expect(duplicate[0]?.node).toBe('MMR');
});

/**
 * The unscoped, EOF-append shape — a smoke run's exact steps: converge a vault,
 * write the narrative through the verb, `>>` a second heading onto the file, and
 * ask the production pipeline (`readDoctorSnapshot` → `diagnoseDoctor`, the same
 * pair `mimir doctor` runs) with NO scope, as a bare invocation outside a Project
 * Binding does. The sibling test above scopes explicitly and splices the
 * duplicate above `## History`; neither of those is what an operator does by
 * hand, so this pins the real one on both axes.
 */
test.skipIf(!NORN)(
  'the unscoped doctor pipeline reports a duplicate appended at EOF (MMR-321)',
  async () => {
    await updateNode(store, await nodeIdOf(store, initiativeRef), { next: 'legit' });
    appendDuplicateNextAtEof(`MMR/${initiativeRef}.md`);

    const findings = await diagnoseDoctor(await doctorDeps.readSnapshot(), undefined);
    const duplicate = findings.filter((f) => f.code === 'duplicate-next-section');
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0]?.stem).toBe(initiativeRef);
    expect(duplicate[0]?.locator).toBe(`MMR/${initiativeRef}.md`);
    expect(duplicate[0]?.severity).toBe('error');
  },
);

/**
 * The trap that produced a false "doctor sees nothing" report during review, and
 * why it is not this feature's bug: `runCli` passes `scope: findBinding(cwd)`
 * (ADR 0011), and doctor filters findings by canonical stem — so an invocation
 * whose Project Binding names a project absent from the vault has NOTHING in
 * scope and reports clean. That silences every check equally, not just this one,
 * so it is pinned here beside the positive case rather than worked around.
 */
test.skipIf(!NORN)(
  'a doctor scope naming another project hides every finding (MMR-321)',
  async () => {
    await updateNode(store, await nodeIdOf(store, initiativeRef), { next: 'legit' });
    appendDuplicateNextAtEof(`MMR/${initiativeRef}.md`);
    const snapshot = await doctorDeps.readSnapshot();

    expect(
      (await diagnoseDoctor(snapshot, 'MMR')).filter((f) => f.code === 'duplicate-next-section'),
    ).toHaveLength(1);
    // A foreign scope matches no stem, so the same snapshot reads clean.
    expect(await diagnoseDoctor(snapshot, 'OTHER')).toEqual([]);
  },
);

// ── Per-transport accept AND apply ─────────────────────────────────────────

test.skipIf(!NORN)('the CLI applies the narrative to a container and a project', async () => {
  await cli(['update', phaseRef, '--direction', 'cli direction']);
  expect(await readNext(phaseRef)).toBe('cli direction');
  await cli(['update', 'MMR', '--direction', 'cli project direction']);
  expect(await readNext('MMR')).toBe('cli project direction');
});

test.skipIf(!NORN)('MCP applies the narrative to a container and a project', async () => {
  expect(
    (await toolUpdate(store, { id: initiativeRef, next: 'mcp direction' })).isError,
  ).toBeUndefined();
  expect(await readNext(initiativeRef)).toBe('mcp direction');
  expect(
    (await toolUpdate(store, { id: 'MMR', next: 'mcp project direction' })).isError,
  ).toBeUndefined();
  expect(await readNext('MMR')).toBe('mcp project direction');
});

test.skipIf(!NORN)('HTTP applies the narrative to a container and a project', async () => {
  const node = await fetch(`${base}/api/nodes/${phaseRef}`, {
    body: JSON.stringify({ next: 'http direction' }),
    headers: { 'content-type': 'application/json' },
    method: 'PATCH',
  });
  expect(node.status).toBe(200);
  expect(((await node.json()) as { next?: string }).next).toBe('http direction');
  expect(await readNext(phaseRef)).toBe('http direction');

  const project = await fetch(`${base}/api/projects/MMR`, {
    body: JSON.stringify({ next: 'http project direction' }),
    headers: { 'content-type': 'application/json' },
    method: 'PATCH',
  });
  expect(project.status).toBe(200);
  expect(((await project.json()) as { next?: string }).next).toBe('http project direction');
  expect(await readNext('MMR')).toBe('http project direction');
});

// ── Create refuses the narrative ───────────────────────────────────────────

/**
 * `update` is the settled write surface (ADR 0026 Decision 2), so create must
 * REFUSE the narrative rather than accept and discard it. The CLI's flag is
 * parsed globally (one options table), so without an explicit guard
 * `create … --direction "…"` exited 0 with the prose dropped on the floor —
 * worse for being exactly where the `--next` hint sends the caller.
 */

test.skipIf(!NORN)('create refuses --direction and points at update (MMR-321)', async () => {
  const out = await cli(
    ['create', 'initiative', 'made with direction', '--parent', 'MMR', '--direction', 'prose'],
    2,
  );
  expect(out).toContain("'--direction' doesn't apply to create");
  expect(out).toContain('mimir update <id> --direction');
  // Refused before any write: the node was never created.
  expect(await cli(['tree', 'MMR'])).not.toContain('made with direction');
});

test.skipIf(!NORN)('the HTTP create body rejects a stray next field (MMR-321)', async () => {
  const res = await fetch(`${base}/api/nodes`, {
    body: JSON.stringify({ next: 'prose', parent: 'MMR', title: 'via http', type: 'initiative' }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error?: { message?: string } }).error?.message).toContain(
    'unknown body field next',
  );
});

// ── Read surface ───────────────────────────────────────────────────────────

test.skipIf(!NORN)('the records view shows the narrative only when set (MMR-321)', async () => {
  expect(await cli(['get', phaseRef])).not.toContain('rendered direction');
  await updateNode(store, await nodeIdOf(store, phaseRef), { next: 'rendered direction' });
  expect(await cli(['get', phaseRef])).toMatch(/\bnext\s+rendered direction\b/);
  await updateProject(store, projectId, { next: 'project direction' });
  expect(await cli(['get', 'MMR'])).toMatch(/\bnext\s+project direction\b/);
});

test.skipIf(!NORN)(
  '--col next is opt-in vocabulary and never lands on a task (MMR-321)',
  async () => {
    await updateNode(store, await nodeIdOf(store, phaseRef), { next: 'column direction' });
    expect(await cli(['get', phaseRef, '--col', 'next', '-f', 'json'])).toContain(
      'column direction',
    );
    // A task carries no `## Next`, so the key is absent even when asked for.
    const task: unknown = JSON.parse(await cli(['get', taskRef, '--col', 'next', '-f', 'json']));
    expect(Object.keys(task as Record<string, unknown>)).not.toContain('next');
  },
);

// ── The `--next` trap ──────────────────────────────────────────────────────

test.skipIf(!NORN)('`--next` is intercepted and pointed at --direction (MMR-321)', async () => {
  // `--next` is self-update's BOOLEAN channel selector, so it swallows no value
  // and the text slides into the positionals: this used to exit 0 having written
  // nothing at all. Every machine surface spells the field `next`, so it is
  // exactly the invocation an agent reaches for.
  const out = await cli(['update', phaseRef, '--next', 'boom'], 2);
  expect(out).toContain("'--next' doesn't apply to update");
  expect(out).toContain('--direction');
  expect(await readNext(phaseRef)).toBeUndefined();
  // Every non-self-update verb is covered, not just `update`.
  expect(await cli(['list', '--next'], 2)).toContain("'--next' doesn't apply to list");
});
