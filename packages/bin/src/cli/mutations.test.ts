import { afterEach, beforeEach, expect, test } from 'bun:test';

import { parseJson } from '@mimir/helpers';

import {
  createInitiative,
  createPhase,
  createProject,
  createSqliteStore,
  createTask,
  deriveSet,
  findNodeInSet,
  updateNode,
} from '../core';
import type { Db, Store } from '../core';
import { createTestDb } from '../db/testing';
import { echoNode, readContent, resolveNode, resolveParent, resolveProject } from './resolve';
import { runCli } from './run';
import { fakeIo } from './testing';

let db: Db;
let store: Store;
let taskRef: string;
let phaseId: number;
let phaseRef: string;
let initiativeId: number;
let initiativeRef: string;
beforeEach(async () => {
  db = await createTestDb();
  store = createSqliteStore(db);
  const p = await createProject(store, { key: 'MMR', name: 'm' });
  const init = await createInitiative(store, { projectId: p.id, title: 'i' });
  initiativeId = init.id;
  initiativeRef = `MMR-${String(init.seq)}`;
  const phase = await createPhase(store, { parentId: init.id, title: 'ph' });
  phaseId = phase.id;
  phaseRef = `MMR-${String(phase.seq)}`;
  const task = await createTask(store, { parentId: phase.id, title: 't' });
  taskRef = `MMR-${String(task.seq)}`;
});
afterEach(async () => {
  await db.destroy();
});

// resolveNode
test('resolveNode returns the surrogate id for a valid KEY-seq', async () => {
  const id = await resolveNode(store, taskRef);
  expect(typeof id).toBe('number');
});
test('resolveNode throws not_found (code) for a missing id', async () => {
  let threw: unknown;
  try {
    await resolveNode(store, 'MMR-9999');
  } catch (e) {
    threw = e;
  }
  expect(threw).toMatchObject({ code: 'not_found' });
});

// resolveProject
test('resolveProject returns the surrogate id for a valid project key', async () => {
  const id = await resolveProject(store, 'MMR');
  expect(typeof id).toBe('number');
});
test('resolveProject throws not_found (code) for a missing project key', async () => {
  let threw: unknown;
  try {
    await resolveProject(store, 'ZZZ');
  } catch (e) {
    threw = e;
  }
  expect(threw).toMatchObject({ code: 'not_found' });
});

// resolveParent
test("resolveParent returns {kind:'project'} for a bare project key", async () => {
  const result = await resolveParent(store, 'MMR');
  expect(result).toMatchObject({ kind: 'project' });
  expect(typeof result.id).toBe('number');
});
test("resolveParent returns {kind:'node'} for a KEY-seq token", async () => {
  const result = await resolveParent(store, taskRef);
  expect(result).toMatchObject({ kind: 'node' });
  expect(typeof result.id).toBe('number');
});

// echoNode
test("echoNode writes bare-node JSON to io.out for format 'json'", async () => {
  const node = findNodeInSet(deriveSet(await store.loadWorkingSet()), taskRef);
  if (node === undefined) {
    throw new Error('node not found');
  }
  const io = fakeIo();
  await echoNode(store, node.id, 'json', io);
  const parsed = parseJson<{ id: string }>(io.out.join(''));
  expect(parsed.id).toBe(taskRef);
});
test('echoNode echoes the description a write just set (MMR-162 — facet-gated)', async () => {
  const node = findNodeInSet(deriveSet(await store.loadWorkingSet()), taskRef);
  if (node === undefined) {
    throw new Error('node not found');
  }
  // description is facet-gated now; the write-echo must still return it, else a
  // `create`/`update --desc` prints a record missing the field it just wrote.
  await updateNode(store, node.id, { description: 'the prose body' });
  const io = fakeIo();
  await echoNode(store, node.id, 'json', io);
  const parsed = parseJson<{ description?: string }>(io.out.join(''));
  expect(parsed.description).toBe('the prose body');
});
test("echoNode writes rendered records text to io.out for format 'records'", async () => {
  const node = findNodeInSet(deriveSet(await store.loadWorkingSet()), taskRef);
  if (node === undefined) {
    throw new Error('node not found');
  }
  const io = fakeIo(true);
  await echoNode(store, node.id, 'records', io);
  const text = io.out.join('');
  expect(text).toContain(taskRef);
  expect(text).toContain('title');
});
test("echoNode writes the bare id to io.out for format 'ids'", async () => {
  const node = findNodeInSet(deriveSet(await store.loadWorkingSet()), taskRef);
  if (node === undefined) {
    throw new Error('node not found');
  }
  const io = fakeIo();
  await echoNode(store, node.id, 'ids', io);
  const text = io.out.join('');
  expect(text).toBe(taskRef);
});
test("echoNode writes a count-led table line to io.out for format 'table'", async () => {
  const node = findNodeInSet(deriveSet(await store.loadWorkingSet()), taskRef);
  if (node === undefined) {
    throw new Error('node not found');
  }
  const io = fakeIo(true);
  await echoNode(store, node.id, 'table', io);
  const text = io.out.join('');
  expect(text).toMatch(/^1 task/);
  expect(text).toContain(taskRef);
});

// readContent
test('readContent returns joined tail when tail is non-empty', async () => {
  const io = fakeIo(false);
  const result = await readContent(['hello', 'world'], io);
  expect(result).toBe('hello world');
});
test('readContent returns empty string when tail is empty and isTTY', async () => {
  const io = fakeIo(true);
  const result = await readContent([], io);
  expect(result).toBe('');
});

// lifecycle verbs via runCli
test('start moves a task to in_progress and echoes it (exit 0)', async () => {
  const io = fakeIo(false);
  const code = await runCli(['start', taskRef, '-f', 'json'], () => store, io);
  expect(code).toBe(0);
  expect(JSON.parse(io.out[0] ?? '{}').status).toBe('in_progress');
});
test('done completes a started task', async () => {
  await runCli(['start', taskRef], () => store, fakeIo(false));
  const io = fakeIo(false);
  const code = await runCli(['done', taskRef, '-f', 'json'], () => store, io);
  expect(code).toBe(0);
  expect(JSON.parse(io.out[0] ?? '{}').status).toBe('done');
});
test('submit moves a started task to under_review (MMR-84)', async () => {
  await runCli(['start', taskRef], () => store, fakeIo(false));
  const io = fakeIo(false);
  const code = await runCli(['submit', taskRef, '-f', 'json'], () => store, io);
  expect(code).toBe(0);
  expect(JSON.parse(io.out[0] ?? '{}').status).toBe('under_review');
});
test('return sends an under_review task back to in_progress with a reason', async () => {
  await runCli(['start', taskRef], () => store, fakeIo(false));
  await runCli(['submit', taskRef], () => store, fakeIo(false));
  const io = fakeIo(false);
  const code = await runCli(
    ['return', taskRef, 'fix', 'the', 'tests', '-f', 'json'],
    () => store,
    io,
  );
  expect(code).toBe(0);
  expect(JSON.parse(io.out[0] ?? '{}').status).toBe('in_progress');
});
test('reopen sends a done task back to in_progress with a reason (MMR-104)', async () => {
  await runCli(['start', taskRef], () => store, fakeIo(false));
  await runCli(['done', taskRef], () => store, fakeIo(false));
  const io = fakeIo(false);
  const code = await runCli(
    ['reopen', taskRef, 'needs', 'verification', '-f', 'json'],
    () => store,
    io,
  );
  expect(code).toBe(0);
  expect(JSON.parse(io.out[0] ?? '{}').status).toBe('in_progress');
});
test('done approves an under_review task', async () => {
  await runCli(['start', taskRef], () => store, fakeIo(false));
  await runCli(['submit', taskRef], () => store, fakeIo(false));
  const io = fakeIo(false);
  expect(await runCli(['done', taskRef, '-f', 'json'], () => store, io)).toBe(0);
  expect(JSON.parse(io.out[0] ?? '{}').status).toBe('done');
});
test('abandon records a reason from the positional tail', async () => {
  const code = await runCli(
    ['abandon', taskRef, 'superseded', 'by', 'nine'],
    () => store,
    fakeIo(false),
  );
  expect(code).toBe(0);
});
test('a mutation on a missing id is not_found → exit 1', async () => {
  const io = fakeIo(false);
  expect(await runCli(['done', 'MMR-9999'], () => store, io)).toBe(1);
  expect(io.out).toHaveLength(0);
});

// hold verbs: park / unpark / block / unblock
test('park sets the hold overlay → reads as parked', async () => {
  const io = fakeIo(false);
  const code = await runCli(
    ['park', taskRef, 'waiting', 'on', 'review', '-f', 'json'],
    () => store,
    io,
  );
  expect(code).toBe(0);
  expect(JSON.parse(io.out[0] ?? '{}').status).toBe('parked');
});
test('unpark clears the hold', async () => {
  await runCli(['park', taskRef], () => store, fakeIo(false));
  expect(await runCli(['unpark', taskRef], () => store, fakeIo(false))).toBe(0);
});
test('block then unblock', async () => {
  expect(await runCli(['block', taskRef, 'ci', 'red'], () => store, fakeIo(false))).toBe(0);
  expect(await runCli(['unblock', taskRef], () => store, fakeIo(false))).toBe(0);
});

// dependency verbs: depend / undepend
test('depend --on adds edges; undepend removes them', async () => {
  const t2 = await createTask(store, { parentId: phaseId, title: 't2' });
  const ref2 = `MMR-${String(t2.seq)}`;
  expect(await runCli(['depend', taskRef, '--on', ref2], () => store, fakeIo(false))).toBe(0);
  expect(await runCli(['undepend', taskRef, '--on', ref2], () => store, fakeIo(false))).toBe(0);
});
test('depend without --on is a usage error → exit 2', async () => {
  expect(await runCli(['depend', taskRef], () => store, fakeIo(false))).toBe(2);
});

// structure verb: move
test('move re-parents under --to', async () => {
  const phase2 = await createPhase(store, { parentId: initiativeId, title: 'ph2' });
  const phase2Ref = `MMR-${String(phase2.seq)}`;
  expect(await runCli(['move', taskRef, '--to', phase2Ref], () => store, fakeIo(false))).toBe(0);
});

// structure verb: reorder
test('reorder --before and --top', async () => {
  const t2 = await createTask(store, { parentId: phaseId, title: 't2' });
  const ref2 = `MMR-${String(t2.seq)}`;
  expect(await runCli(['reorder', taskRef, '--before', ref2], () => store, fakeIo(false))).toBe(0);
  expect(await runCli(['reorder', taskRef, '--top'], () => store, fakeIo(false))).toBe(0);
});
test('reorder with no position flag is a usage error → exit 2', async () => {
  expect(await runCli(['reorder', taskRef], () => store, fakeIo(false))).toBe(2);
});

// data verbs: update / annotate
test('update patches scalar fields and echoes them', async () => {
  const io = fakeIo(false);
  const code = await runCli(
    ['update', taskRef, '--priority', 'p1', '--size', 'large', '--title', 'renamed', '-f', 'json'],
    () => store,
    io,
  );
  expect(code).toBe(0);
  const v = JSON.parse(io.out[0] ?? '{}');
  expect(v.priority).toBe('p1');
  expect(v.title).toBe('renamed');
});
test('update rejects an invalid priority as usage → exit 2', async () => {
  expect(await runCli(['update', taskRef, '--priority', 'p9'], () => store, fakeIo(false))).toBe(2);
});
test('annotate from the positional tail exits 0', async () => {
  expect(
    await runCli(['annotate', taskRef, 'looked', 'into', 'this'], () => store, fakeIo(false)),
  ).toBe(0);
});
test('annotate with no content is a usage error → exit 2', async () => {
  expect(await runCli(['annotate', taskRef], () => store, fakeIo(true))).toBe(2); // isTTY=true so stdin isn't read
});

// create verbs
test('create project echoes the new key', async () => {
  const io = fakeIo(false);
  const code = await runCli(
    ['create', 'project', '--key', 'NEW', '--name', 'New Proj', '-y'],
    () => store,
    io,
  );
  expect(code).toBe(0);
  expect(io.out.join('')).toContain('NEW');
});
test('create task under a phase, with signals', async () => {
  const io = fakeIo(false);
  const code = await runCli(
    ['create', 'task', 'A new task', '--parent', phaseRef, '--priority', 'p2', '-f', 'json'],
    () => store,
    io,
  );
  expect(code).toBe(0);
  const v = JSON.parse(io.out[0] ?? '{}');
  expect(v.type).toBe('task');
  expect(v.title).toBe('A new task');
});
test('create initiative under a bare project KEY', async () => {
  expect(
    await runCli(
      ['create', 'initiative', 'Big bet', '--parent', 'MMR'],
      () => store,
      fakeIo(false),
    ),
  ).toBe(0);
});
test('create with an unknown type is a usage error → exit 2', async () => {
  expect(
    await runCli(['create', 'widget', 'x', '--parent', 'MMR'], () => store, fakeIo(false)),
  ).toBe(2);
});
test('create task without --parent is a usage error → exit 2', async () => {
  expect(await runCli(['create', 'task', 'orphan'], () => store, fakeIo(false))).toBe(2);
});

// attach verb
test('attach to a node infers the project and echoes an artifact id', async () => {
  const tmp = `${process.env.TMPDIR ?? '/tmp'}/mimir-attach-ok.md`;
  await Bun.write(tmp, '# plan\n');
  const io = fakeIo(false);
  const code = await runCli(['attach', taskRef, '--file', tmp, '-f', 'json'], () => store, io);
  expect(code).toBe(0);
  expect(JSON.parse(io.out[0] ?? '{}').artifact.id).toMatch(/^[A-Z]{2,4}-a\d+$/);
});
test('attach rejects a --link in a different project (validation → exit 1)', async () => {
  const other = await createProject(store, { key: 'OTH', name: 'o' });
  const oi = await createInitiative(store, { projectId: other.id, title: 'i' });
  const op = await createPhase(store, { parentId: oi.id, title: 'p' });
  const ot = await createTask(store, { parentId: op.id, title: 't' });
  const tmp = `${process.env.TMPDIR ?? '/tmp'}/mimir-attach-x.md`;
  await Bun.write(tmp, 'x');
  const io = fakeIo(false);
  const code = await runCli(
    ['attach', taskRef, '--file', tmp, '--link', `OTH-${String(ot.seq)}`],
    () => store,
    io,
  );
  expect(code).toBe(1);
  expect(io.out).toHaveLength(0);
});
test('attach with no content and no --file on a TTY is a usage error → exit 2', async () => {
  expect(await runCli(['attach', taskRef], () => store, fakeIo(true))).toBe(2); // isTTY=true ⇒ stdin not read
});
test('attach to a missing node is not_found → exit 1', async () => {
  const tmp = `${process.env.TMPDIR ?? '/tmp'}/mimir-attach-nf.md`;
  await Bun.write(tmp, 'x');
  expect(await runCli(['attach', 'MMR-9999', '--file', tmp], () => store, fakeIo(false))).toBe(1);
});

test('blank required tokens are usage errors → exit 2, not not_found (MMR-41)', async () => {
  // flag tokens
  expect(await runCli(['move', taskRef, '--to', ''], () => store, fakeIo(false))).toBe(2);
  expect(await runCli(['depend', taskRef, '--on', ''], () => store, fakeIo(false))).toBe(2);
  expect(await runCli(['undepend', taskRef, '--on', ''], () => store, fakeIo(false))).toBe(2);
  expect(await runCli(['reorder', taskRef, '--before', ''], () => store, fakeIo(false))).toBe(2);
  expect(await runCli(['reorder', taskRef, '--after', ''], () => store, fakeIo(false))).toBe(2);
  // a blank entry inside a csv list is the same malformation
  expect(await runCli(['depend', taskRef, '--on', `${taskRef},`], () => store, fakeIo(false))).toBe(
    2,
  );
  // blank positional id
  expect(await runCli(['start', ''], () => store, fakeIo(false))).toBe(2);
});

test('update KEY-aN retitles the artifact; node-only flags refused (MMR-40)', async () => {
  const tmp = `${process.env.TMPDIR ?? '/tmp'}/mimir-retitle.md`;
  await Bun.write(tmp, '# body');
  const io = fakeIo(false);
  expect(
    await runCli(
      ['attach', taskRef, '--file', tmp, '--title', 'wrong', '-f', 'json'],
      () => store,
      io,
    ),
  ).toBe(0);
  const aId = parseJson<{ artifact: { id: string } }>(io.out.join('')).artifact.id;

  const echo = fakeIo(false);
  expect(await runCli(['update', aId, '--title', 'right', '-f', 'json'], () => store, echo)).toBe(
    0,
  );
  const detail = parseJson<{ id: string; title: string }>(echo.out.join(''));
  expect(detail.id).toBe(aId);
  expect(detail.title).toBe('right');

  // node-only flags on an artifact id are a behavioral error → exit 1
  expect(await runCli(['update', aId, '--priority', 'p1'], () => store, fakeIo(false))).toBe(1);
  // blank title is validation (the field is being set badly, not missing) → exit 1
  expect(await runCli(['update', aId, '--title', ''], () => store, fakeIo(false))).toBe(1);
  // unknown artifact → not_found
  expect(await runCli(['update', 'MMR-a999', '--title', 'x'], () => store, fakeIo(false))).toBe(1);
});

// project update + create with description (MMR-88)
test('update KEY renames a project with --name and echoes the updated record', async () => {
  const io = fakeIo(false);
  const code = await runCli(['update', 'MMR', '--name', 'Renamed', '-f', 'json'], () => store, io);
  expect(code).toBe(0);
  const v = parseJson<{ type: string; title: string; id: string }>(io.out[0] ?? '{}');
  expect(v.type).toBe('project');
  expect(v.id).toBe('MMR');
  expect(v.title).toBe('Renamed');
});

test('update KEY sets description with --desc and echoes it', async () => {
  const io = fakeIo(false);
  const code = await runCli(
    ['update', 'MMR', '--desc', 'work state manager', '-f', 'json'],
    () => store,
    io,
  );
  expect(code).toBe(0);
  const v = parseJson<{ description: string }>(io.out[0] ?? '{}');
  expect(v.description).toBe('work state manager');
});

test('update KEY renders description in records format', async () => {
  await runCli(['update', 'MMR', '--desc', 'a description'], () => store, fakeIo(false));
  const io = fakeIo(true);
  const code = await runCli(['update', 'MMR', '--name', 'Keep'], () => store, io);
  expect(code).toBe(0);
  expect(io.out.join('')).toContain('description');
});

test('update KEY refuses node-only flags → exit 1', async () => {
  expect(await runCli(['update', 'MMR', '--title', 'x'], () => store, fakeIo(false))).toBe(1);
  expect(await runCli(['update', 'MMR', '--priority', 'p1'], () => store, fakeIo(false))).toBe(1);
});

test('update on missing project key → not_found (exit 1)', async () => {
  expect(await runCli(['update', 'ZZZ', '--name', 'x'], () => store, fakeIo(false))).toBe(1);
});

test('create project with --desc stores the description', async () => {
  const io = fakeIo(false);
  const code = await runCli(
    ['create', 'project', '--key', 'DSC', '--name', 'Described', '--desc', 'some desc', '-y'],
    () => store,
    io,
  );
  expect(code).toBe(0);
  // Verify description was stored via get
  const getIo = fakeIo(false);
  await runCli(['get', 'DSC', '-f', 'json'], () => store, getIo);
  const v = parseJson<{ description: string }>(getIo.out[0] ?? '{}');
  expect(v.description).toBe('some desc');
});

// open_ended container flag (MMR-204)
test('create phase --open-ended sets the flag; get surfaces it', async () => {
  const echo = fakeIo(true);
  expect(
    await runCli(
      ['create', 'phase', 'bugs', '--parent', initiativeRef, '--open-ended', '-f', 'json'],
      () => store,
      echo,
    ),
  ).toBe(0);
  const created = parseJson<{ id: string; open_ended?: boolean | null }>(echo.out.join(''));
  const got = fakeIo(true);
  await runCli(['get', created.id, '-f', 'json'], () => store, got);
  expect(parseJson<{ open_ended?: boolean | null }>(got.out.join('')).open_ended).toBe(true);
});

test('update --open-ended / --not-open-ended toggles a container flag', async () => {
  const on = fakeIo(true);
  expect(await runCli(['update', phaseRef, '--open-ended', '-f', 'json'], () => store, on)).toBe(0);
  const readBack = async (): Promise<boolean | null | undefined> => {
    const io = fakeIo(true);
    await runCli(['get', phaseRef, '-f', 'json'], () => store, io);
    return parseJson<{ open_ended?: boolean | null }>(io.out.join('')).open_ended;
  };
  expect(await readBack()).toBe(true);
  expect(await runCli(['update', phaseRef, '--not-open-ended'], () => store, fakeIo(false))).toBe(
    0,
  );
  expect(await readBack()).toBe(false);
});

test('--open-ended on a task is a validation error (container-only)', async () => {
  expect(await runCli(['update', taskRef, '--open-ended'], () => store, fakeIo(false))).toBe(1);
});

test('--open-ended on a project is a validation error', async () => {
  expect(await runCli(['update', 'MMR', '--open-ended'], () => store, fakeIo(false))).toBe(1);
});

test('both --open-ended and --not-open-ended is a usage error', async () => {
  expect(
    await runCli(
      ['update', phaseRef, '--open-ended', '--not-open-ended'],
      () => store,
      fakeIo(false),
    ),
  ).toBe(2);
});
