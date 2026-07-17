import { afterEach, beforeEach, expect, test } from 'bun:test';

import { parseJson } from '@mimir/helpers';

import {
  createInitiative,
  createPhase,
  createProject,
  createTask,
  deriveSet,
  findNodeInSet,
  updateNode,
} from '../core';
import type { Store } from '../core';
import { createTestStore, nodeIdOf, projectIdOf } from '../testing/store';
import { echoNode, readContent, resolveNode, resolveProject } from './resolve';
import { runCli } from './run';
import { fakeIo } from './testing';

const NORN = Bun.which('norn') !== null;

let store: Store;
let closeStore: (() => Promise<void>) | undefined;
let taskRef: string;
let phaseId: string;
let phaseRef: string;
let initiativeId: string;
let initiativeRef: string;
beforeEach(async () => {
  // The pure readContent tests below run norn-less; the store fixture only
  // builds when the gated store tests will actually run.
  if (!NORN) {
    return;
  }
  ({ close: closeStore, store } = await createTestStore());
  await createProject(store, { key: 'MMR', name: 'm' });
  const projectId = await projectIdOf(store, 'MMR');
  const init = await createInitiative(store, { projectId, title: 'i' });
  initiativeRef = `MMR-${String(init.seq)}`;
  initiativeId = await nodeIdOf(store, initiativeRef);
  const phase = await createPhase(store, { parentId: initiativeId, title: 'ph' });
  phaseRef = `MMR-${String(phase.seq)}`;
  phaseId = await nodeIdOf(store, phaseRef);
  const task = await createTask(store, { parentId: phaseId, title: 't' });
  taskRef = `MMR-${String(task.seq)}`;
});
afterEach(async () => {
  await closeStore?.();
});

// resolveNode
test.skipIf(!NORN)('resolveNode returns the canonical stem for a valid KEY-seq', async () => {
  const id = await resolveNode(store, taskRef);
  expect(id).toBe(taskRef);
});
test.skipIf(!NORN)('resolveNode throws not_found (code) for a missing id', async () => {
  let threw: unknown;
  try {
    await resolveNode(store, 'MMR-9999');
  } catch (e) {
    threw = e;
  }
  expect(threw).toMatchObject({ code: 'not_found' });
});

// resolveProject
test.skipIf(!NORN)('resolveProject returns the canonical project key', async () => {
  const id = await resolveProject(store, 'MMR');
  expect(id).toBe('MMR');
});
test.skipIf(!NORN)('resolveProject throws not_found (code) for a missing project key', async () => {
  let threw: unknown;
  try {
    await resolveProject(store, 'ZZZ');
  } catch (e) {
    threw = e;
  }
  expect(threw).toMatchObject({ code: 'not_found' });
});

// echoNode
test.skipIf(!NORN)("echoNode writes bare-node JSON to io.out for format 'json'", async () => {
  const node = findNodeInSet(deriveSet(await store.loadWorkingSet()), taskRef);
  if (node === undefined) {
    throw new Error('node not found');
  }
  const io = fakeIo();
  await echoNode(store, node.id, 'json', io);
  const parsed = parseJson<{ id: string }>(io.out.join(''));
  expect(parsed.id).toBe(taskRef);
});
test.skipIf(!NORN)(
  'echoNode echoes the description a write just set (MMR-162 — facet-gated)',
  async () => {
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
  },
);
test.skipIf(!NORN)(
  "echoNode writes rendered records text to io.out for format 'records'",
  async () => {
    const node = findNodeInSet(deriveSet(await store.loadWorkingSet()), taskRef);
    if (node === undefined) {
      throw new Error('node not found');
    }
    const io = fakeIo(true);
    await echoNode(store, node.id, 'records', io);
    const text = io.out.join('');
    expect(text).toContain(taskRef);
    expect(text).toContain('title');
  },
);
test.skipIf(!NORN)("echoNode writes the bare id to io.out for format 'ids'", async () => {
  const node = findNodeInSet(deriveSet(await store.loadWorkingSet()), taskRef);
  if (node === undefined) {
    throw new Error('node not found');
  }
  const io = fakeIo();
  await echoNode(store, node.id, 'ids', io);
  const text = io.out.join('');
  expect(text).toBe(taskRef);
});
test.skipIf(!NORN)(
  "echoNode writes a count-led table line to io.out for format 'table'",
  async () => {
    const node = findNodeInSet(deriveSet(await store.loadWorkingSet()), taskRef);
    if (node === undefined) {
      throw new Error('node not found');
    }
    const io = fakeIo(true);
    await echoNode(store, node.id, 'table', io);
    const text = io.out.join('');
    expect(text).toMatch(/^1 task/);
    expect(text).toContain(taskRef);
  },
);

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
test.skipIf(!NORN)('start moves a task to in_progress and echoes it (exit 0)', async () => {
  const io = fakeIo(false);
  const code = await runCli(['start', taskRef, '-f', 'json'], () => store, io);
  expect(code).toBe(0);
  expect(JSON.parse(io.out[0] ?? '{}').status).toBe('in_progress');
});
test.skipIf(!NORN)('done completes a started task', async () => {
  await runCli(['start', taskRef], () => store, fakeIo(false));
  const io = fakeIo(false);
  const code = await runCli(['done', taskRef, '-f', 'json'], () => store, io);
  expect(code).toBe(0);
  expect(JSON.parse(io.out[0] ?? '{}').status).toBe('done');
});
test.skipIf(!NORN)('submit moves a started task to under_review (MMR-84)', async () => {
  await runCli(['start', taskRef], () => store, fakeIo(false));
  const io = fakeIo(false);
  const code = await runCli(['submit', taskRef, '-f', 'json'], () => store, io);
  expect(code).toBe(0);
  expect(JSON.parse(io.out[0] ?? '{}').status).toBe('under_review');
});
test.skipIf(!NORN)(
  'return sends an under_review task back to in_progress with a reason',
  async () => {
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
  },
);
test.skipIf(!NORN)(
  'reopen sends a done task back to in_progress with a reason (MMR-104)',
  async () => {
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
  },
);
test.skipIf(!NORN)('done approves an under_review task', async () => {
  await runCli(['start', taskRef], () => store, fakeIo(false));
  await runCli(['submit', taskRef], () => store, fakeIo(false));
  const io = fakeIo(false);
  expect(await runCli(['done', taskRef, '-f', 'json'], () => store, io)).toBe(0);
  expect(JSON.parse(io.out[0] ?? '{}').status).toBe('done');
});
test.skipIf(!NORN)('abandon records a reason from the positional tail', async () => {
  const code = await runCli(
    ['abandon', taskRef, 'superseded', 'by', 'nine'],
    () => store,
    fakeIo(false),
  );
  expect(code).toBe(0);
});
test.skipIf(!NORN)('a mutation on a missing id is not_found → exit 1', async () => {
  const io = fakeIo(false);
  expect(await runCli(['done', 'MMR-9999'], () => store, io)).toBe(1);
  expect(io.out).toHaveLength(0);
});

// hold verbs: park / unpark / block / unblock
test.skipIf(!NORN)('park sets the hold overlay → reads as parked', async () => {
  const io = fakeIo(false);
  const code = await runCli(
    ['park', taskRef, 'waiting', 'on', 'review', '-f', 'json'],
    () => store,
    io,
  );
  expect(code).toBe(0);
  expect(JSON.parse(io.out[0] ?? '{}').status).toBe('parked');
});
test.skipIf(!NORN)('unpark clears the hold', async () => {
  await runCli(['park', taskRef], () => store, fakeIo(false));
  expect(await runCli(['unpark', taskRef], () => store, fakeIo(false))).toBe(0);
});
test.skipIf(!NORN)('block then unblock', async () => {
  expect(await runCli(['block', taskRef, 'ci', 'red'], () => store, fakeIo(false))).toBe(0);
  expect(await runCli(['unblock', taskRef], () => store, fakeIo(false))).toBe(0);
});

// dependency verbs: depend / undepend
test.skipIf(!NORN)('depend --on adds edges; undepend removes them', async () => {
  const t2 = await createTask(store, { parentId: phaseId, title: 't2' });
  const ref2 = `MMR-${String(t2.seq)}`;
  expect(await runCli(['depend', taskRef, '--on', ref2], () => store, fakeIo(false))).toBe(0);
  expect(await runCli(['undepend', taskRef, '--on', ref2], () => store, fakeIo(false))).toBe(0);
});
test.skipIf(!NORN)('depend without --on is a usage error → exit 2', async () => {
  expect(await runCli(['depend', taskRef], () => store, fakeIo(false))).toBe(2);
});

// structure verb: move
test.skipIf(!NORN)('move re-parents under --to', async () => {
  const phase2 = await createPhase(store, { parentId: initiativeId, title: 'ph2' });
  const phase2Ref = `MMR-${String(phase2.seq)}`;
  expect(await runCli(['move', taskRef, '--to', phase2Ref], () => store, fakeIo(false))).toBe(0);
});

// structure verb: reorder
test.skipIf(!NORN)('reorder --before and --top', async () => {
  const t2 = await createTask(store, { parentId: phaseId, title: 't2' });
  const ref2 = `MMR-${String(t2.seq)}`;
  expect(await runCli(['reorder', taskRef, '--before', ref2], () => store, fakeIo(false))).toBe(0);
  expect(await runCli(['reorder', taskRef, '--top'], () => store, fakeIo(false))).toBe(0);
});
test.skipIf(!NORN)('reorder with no position flag is a usage error → exit 2', async () => {
  expect(await runCli(['reorder', taskRef], () => store, fakeIo(false))).toBe(2);
});

// data verbs: update / annotate
test.skipIf(!NORN)('update patches scalar fields and echoes them', async () => {
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
test.skipIf(!NORN)('update rejects an invalid priority as usage → exit 2', async () => {
  expect(await runCli(['update', taskRef, '--priority', 'p9'], () => store, fakeIo(false))).toBe(2);
});

test.skipIf(!NORN)(
  'update --upstream patches the seed pointer and echoes it (MMR-284)',
  async () => {
    const io = fakeIo(false);
    const code = await runCli(
      ['update', taskRef, '--upstream', 'NRN-s3', '-f', 'json'],
      () => store,
      io,
    );
    expect(code).toBe(0);
    const v = JSON.parse(io.out[0] ?? '{}');
    expect(v.upstream).toBe('NRN-s3');
  },
);

test.skipIf(!NORN)(
  'update --upstream rejects a non-seed-id as usage → exit 2 (MMR-284)',
  async () => {
    expect(
      await runCli(['update', taskRef, '--upstream', 'not-a-seed'], () => store, fakeIo(false)),
    ).toBe(2);
  },
);

test.skipIf(!NORN)(
  'update --upstream on a phase is a validation error → exit 1 (MMR-284)',
  async () => {
    expect(
      await runCli(['update', phaseRef, '--upstream', 'NRN-s3'], () => store, fakeIo(false)),
    ).toBe(1);
  },
);

test.skipIf(!NORN)(
  'update --upstream none clears a set seed pointer (set-then-clear roundtrip, MMR-301)',
  async () => {
    const setIo = fakeIo(false);
    await runCli(['update', taskRef, '--upstream', 'NRN-s3', '-f', 'json'], () => store, setIo);
    expect(JSON.parse(setIo.out[0] ?? '{}').upstream).toBe('NRN-s3');

    const clearIo = fakeIo(false);
    const code = await runCli(
      ['update', taskRef, '--upstream', 'none', '-f', 'json'],
      () => store,
      clearIo,
    );
    expect(code).toBe(0);
    expect(JSON.parse(clearIo.out[0] ?? '{}').upstream).toBeNull();
  },
);

test.skipIf(!NORN)(
  'update --upstream none on an already-empty upstream is idempotent (MMR-301)',
  async () => {
    const io = fakeIo(false);
    const code = await runCli(
      ['update', taskRef, '--upstream', 'none', '-f', 'json'],
      () => store,
      io,
    );
    expect(code).toBe(0);
    expect(JSON.parse(io.out[0] ?? '{}').upstream).toBeNull();
  },
);

test.skipIf(!NORN)(
  'update --upstream "" (blank) is still rejected, not treated as clear (MMR-301)',
  async () => {
    expect(
      await runCli(['update', taskRef, '--upstream', '', '-f', 'json'], () => store, fakeIo(false)),
    ).toBe(2);
  },
);

test.skipIf(!NORN)(
  'update --upstream none leaves an unrelated field untouched (MMR-301)',
  async () => {
    const io = fakeIo(false);
    const code = await runCli(
      ['update', taskRef, '--title', 'renamed via clear', '--upstream', 'none', '-f', 'json'],
      () => store,
      io,
    );
    expect(code).toBe(0);
    const v = JSON.parse(io.out[0] ?? '{}');
    expect(v.upstream).toBeNull();
    expect(v.title).toBe('renamed via clear');
  },
);
test.skipIf(!NORN)('annotate from the positional tail exits 0', async () => {
  expect(
    await runCli(['annotate', taskRef, 'looked', 'into', 'this'], () => store, fakeIo(false)),
  ).toBe(0);
});
test.skipIf(!NORN)('annotate with no content is a usage error → exit 2', async () => {
  expect(await runCli(['annotate', taskRef], () => store, fakeIo(true))).toBe(2); // isTTY=true so stdin isn't read
});
test.skipIf(!NORN)(
  'annotate on a container echoes the true rollup, matching get (MMR-242)',
  async () => {
    // phase already carries one task (taskRef, from beforeEach) — add a second so
    // the count is unambiguous and the plural form exercises.
    await createTask(store, { parentId: phaseId, title: 't2' });

    const getIo = fakeIo(false);
    expect(await runCli(['get', phaseRef, '-f', 'json'], () => store, getIo)).toBe(0);
    const getView = parseJson<{ distribution: Record<string, number> }>(getIo.out.join(''));

    const annotateIo = fakeIo(false);
    expect(
      await runCli(['annotate', phaseRef, 'checked', 'in', '-f', 'json'], () => store, annotateIo),
    ).toBe(0);
    const annotateView = parseJson<{ distribution: Record<string, number> }>(
      annotateIo.out.join(''),
    );

    // The mutation echo must derive its rollup from the same source as `get` —
    // not read as an unloaded, childless node.
    expect(annotateView.distribution).toEqual(getView.distribution);

    const recordsIo = fakeIo(true); // TTY — the rollup signpost is styled-format-only
    expect(await runCli(['annotate', phaseRef, 'checked', 'again'], () => store, recordsIo)).toBe(
      0,
    );
    const text = recordsIo.out.join('');
    expect(text).toContain('rollup over 2 direct children');
    expect(text).not.toContain('rollup over 0 direct children');
  },
);
test.skipIf(!NORN)(
  'update on a project echoes the true rollup, matching get (MMR-242)',
  async () => {
    // The project already carries one root initiative (from beforeEach) — add a
    // second so the count is unambiguous and the plural form exercises.
    await createInitiative(store, { projectId: await resolveProject(store, 'MMR'), title: 'i2' });

    const getIo = fakeIo(false);
    expect(await runCli(['get', 'MMR', '-f', 'json'], () => store, getIo)).toBe(0);
    const getView = parseJson<{ children: unknown[]; distribution: Record<string, number> }>(
      getIo.out.join(''),
    );

    const updateIo = fakeIo(false);
    expect(
      await runCli(
        ['update', 'MMR', '--desc', 'renamed body', '-f', 'json'],
        () => store,
        updateIo,
      ),
    ).toBe(0);
    const updateView = parseJson<{ children: unknown[]; distribution: Record<string, number> }>(
      updateIo.out.join(''),
    );

    // The project write-echo must derive its rollup from the same sources as
    // `get KEY` — not read as an unloaded, childless project.
    expect(updateView.children).toEqual(getView.children);
    expect(updateView.distribution).toEqual(getView.distribution);

    const recordsIo = fakeIo(true); // TTY — the rollup signpost is styled-format-only
    expect(await runCli(['update', 'MMR', '--desc', 'again'], () => store, recordsIo)).toBe(0);
    const text = recordsIo.out.join('');
    expect(text).toContain('rollup over 2 direct children');
    expect(text).not.toContain('rollup over 0 direct children');
  },
);

// create verbs
test.skipIf(!NORN)('create project echoes the new key', async () => {
  const io = fakeIo(false);
  const code = await runCli(
    ['create', 'project', '--key', 'NEW', '--name', 'New Proj', '-y'],
    () => store,
    io,
  );
  expect(code).toBe(0);
  expect(io.out.join('')).toContain('NEW');
});
test.skipIf(!NORN)('create task under a phase, with signals', async () => {
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
test.skipIf(!NORN)('create initiative under a bare project KEY', async () => {
  expect(
    await runCli(
      ['create', 'initiative', 'Big bet', '--parent', 'MMR'],
      () => store,
      fakeIo(false),
    ),
  ).toBe(0);
});
test.skipIf(!NORN)('create with an unknown type is a usage error → exit 2', async () => {
  expect(
    await runCli(['create', 'widget', 'x', '--parent', 'MMR'], () => store, fakeIo(false)),
  ).toBe(2);
});
test.skipIf(!NORN)('create task without --parent is a usage error → exit 2', async () => {
  expect(await runCli(['create', 'task', 'orphan'], () => store, fakeIo(false))).toBe(2);
});

// attach verb
test.skipIf(!NORN)('attach to a node infers the project and echoes an artifact id', async () => {
  const tmp = `${process.env.TMPDIR ?? '/tmp'}/mimir-attach-ok.md`;
  await Bun.write(tmp, '# plan\n');
  const io = fakeIo(false);
  const code = await runCli(['attach', taskRef, '--file', tmp, '-f', 'json'], () => store, io);
  expect(code).toBe(0);
  expect(JSON.parse(io.out[0] ?? '{}').artifact.id).toMatch(/^[A-Z]{2,4}-a\d+$/);
});
test.skipIf(!NORN)(
  'attach rejects a --link in a different project (validation → exit 1)',
  async () => {
    await createProject(store, { key: 'OTH', name: 'o' });
    const otherProjectId = await projectIdOf(store, 'OTH');
    const oi = await createInitiative(store, { projectId: otherProjectId, title: 'i' });
    const oiId = await nodeIdOf(store, `OTH-${String(oi.seq)}`);
    const op = await createPhase(store, { parentId: oiId, title: 'p' });
    const opId = await nodeIdOf(store, `OTH-${String(op.seq)}`);
    const ot = await createTask(store, { parentId: opId, title: 't' });
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
  },
);
test.skipIf(!NORN)(
  'attach with no content and no --file on a TTY is a usage error → exit 2',
  async () => {
    expect(await runCli(['attach', taskRef], () => store, fakeIo(true))).toBe(2); // isTTY=true ⇒ stdin not read
  },
);
test.skipIf(!NORN)('attach to a missing node is not_found → exit 1', async () => {
  const tmp = `${process.env.TMPDIR ?? '/tmp'}/mimir-attach-nf.md`;
  await Bun.write(tmp, 'x');
  expect(await runCli(['attach', 'MMR-9999', '--file', tmp], () => store, fakeIo(false))).toBe(1);
});

test.skipIf(!NORN)(
  'blank required tokens are usage errors → exit 2, not not_found (MMR-41)',
  async () => {
    // flag tokens
    expect(await runCli(['move', taskRef, '--to', ''], () => store, fakeIo(false))).toBe(2);
    expect(await runCli(['depend', taskRef, '--on', ''], () => store, fakeIo(false))).toBe(2);
    expect(await runCli(['undepend', taskRef, '--on', ''], () => store, fakeIo(false))).toBe(2);
    expect(await runCli(['reorder', taskRef, '--before', ''], () => store, fakeIo(false))).toBe(2);
    expect(await runCli(['reorder', taskRef, '--after', ''], () => store, fakeIo(false))).toBe(2);
    // a blank entry inside a csv list is the same malformation
    expect(
      await runCli(['depend', taskRef, '--on', `${taskRef},`], () => store, fakeIo(false)),
    ).toBe(2);
    // blank positional id
    expect(await runCli(['start', ''], () => store, fakeIo(false))).toBe(2);
  },
);

test.skipIf(!NORN)(
  'update KEY-aN retitles the artifact; node-only flags refused (MMR-40)',
  async () => {
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
    expect(await runCli(['update', aId, '--upstream', 'NRN-s3'], () => store, fakeIo(false))).toBe(
      1,
    );
    // blank title is validation (the field is being set badly, not missing) → exit 1
    expect(await runCli(['update', aId, '--title', ''], () => store, fakeIo(false))).toBe(1);
    // unknown artifact → not_found
    expect(await runCli(['update', 'MMR-a999', '--title', 'x'], () => store, fakeIo(false))).toBe(
      1,
    );
  },
);

// project update + create with description (MMR-88)
test.skipIf(!NORN)(
  'update KEY renames a project with --name and echoes the updated record',
  async () => {
    const io = fakeIo(false);
    const code = await runCli(
      ['update', 'MMR', '--name', 'Renamed', '-f', 'json'],
      () => store,
      io,
    );
    expect(code).toBe(0);
    const v = parseJson<{ type: string; title: string; id: string }>(io.out[0] ?? '{}');
    expect(v.type).toBe('project');
    expect(v.id).toBe('MMR');
    expect(v.title).toBe('Renamed');
  },
);

test.skipIf(!NORN)('update KEY sets description with --desc and echoes it', async () => {
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

test.skipIf(!NORN)('update KEY renders description in records format', async () => {
  await runCli(['update', 'MMR', '--desc', 'a description'], () => store, fakeIo(false));
  const io = fakeIo(true);
  const code = await runCli(['update', 'MMR', '--name', 'Keep'], () => store, io);
  expect(code).toBe(0);
  expect(io.out.join('')).toContain('description');
});

test.skipIf(!NORN)('update KEY refuses node-only flags → exit 1', async () => {
  expect(await runCli(['update', 'MMR', '--title', 'x'], () => store, fakeIo(false))).toBe(1);
  expect(await runCli(['update', 'MMR', '--priority', 'p1'], () => store, fakeIo(false))).toBe(1);
  expect(await runCli(['update', 'MMR', '--upstream', 'NRN-s3'], () => store, fakeIo(false))).toBe(
    1,
  );
});

test.skipIf(!NORN)('update on missing project key → not_found (exit 1)', async () => {
  expect(await runCli(['update', 'ZZZ', '--name', 'x'], () => store, fakeIo(false))).toBe(1);
});

test.skipIf(!NORN)('create project with --desc stores the description', async () => {
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
test.skipIf(!NORN)('create phase --open-ended sets the flag; get surfaces it', async () => {
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

test.skipIf(!NORN)('update --open-ended / --not-open-ended toggles a container flag', async () => {
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

test.skipIf(!NORN)('--open-ended on a task is a validation error (container-only)', async () => {
  expect(await runCli(['update', taskRef, '--open-ended'], () => store, fakeIo(false))).toBe(1);
});

test.skipIf(!NORN)('--open-ended on a project is a validation error', async () => {
  expect(await runCli(['update', 'MMR', '--open-ended'], () => store, fakeIo(false))).toBe(1);
});

test.skipIf(!NORN)('both --open-ended and --not-open-ended is a usage error', async () => {
  expect(
    await runCli(
      ['update', phaseRef, '--open-ended', '--not-open-ended'],
      () => store,
      fakeIo(false),
    ),
  ).toBe(2);
});

test.skipIf(!NORN)(
  'create --open-ended on a task is a validation error (container-only, MMR-204)',
  async () => {
    expect(
      await runCli(
        ['create', 'task', 'x', '--parent', phaseRef, '--open-ended'],
        () => store,
        fakeIo(false),
      ),
    ).toBe(1);
  },
);

test.skipIf(!NORN)('create --open-ended on a project is a validation error (MMR-204)', async () => {
  expect(
    await runCli(
      ['create', 'project', 'P', '--key', 'PPP', '-y', '--open-ended'],
      () => store,
      fakeIo(false),
    ),
  ).toBe(1);
});

test.skipIf(!NORN)(
  'records view surfaces open-ended for a standing container (MMR-204)',
  async () => {
    await runCli(['update', phaseRef, '--open-ended'], () => store, fakeIo(false));
    const io = fakeIo(true);
    await runCli(['get', phaseRef], () => store, io); // default format = records
    expect(io.out.join('')).toContain('open-ended');
  },
);

test.skipIf(!NORN)(
  'records view surfaces upstream when set, omits it when unset (MMR-252)',
  async () => {
    const unset = fakeIo(true);
    await runCli(['get', taskRef], () => store, unset); // default format = records
    expect(unset.out.join('')).not.toContain('upstream');

    await runCli(['update', taskRef, '--upstream', 'NRN-s3'], () => store, fakeIo(false));
    const set = fakeIo(true);
    await runCli(['get', taskRef], () => store, set);
    expect(set.out.join('')).toContain('upstream');
    expect(set.out.join('')).toContain('NRN-s3');
  },
);
