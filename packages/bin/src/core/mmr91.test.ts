/**
 * MMR-91 — Actionable error hints: container lifecycle + missing project.
 *
 * The error sites populate `MimirError.hint`; `renderError` carries that hint
 * into both renderings — the human `note:` line and the machine error envelope.
 * We assert the hint at the throw site and exercise both renderings end-to-end.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { parseJson } from '@mimir/helpers';

import { renderError } from '../cli/errors';
import type { RenderableError } from '../cli/errors';
import type { Io } from '../cli/render';
import { resolveProject } from '../cli/resolve';
import { createTestDb } from '../db/testing';
import type { Db } from './context';
import { createInitiative, createPhase, createProject, createTask } from './create';
import { deriveSet } from './derive';
import { MimirError } from './errors';
import { nextTasks } from './intent/queries';
import { completeTask, startTask } from './mutations';
import { resolveEntityTokenInSet } from './resolve-set';
import { projectTree } from './resource';
import type { Store } from './store';
import { createSqliteStore } from './store-sqlite';

let db: Db;
let store: Store;
let phaseId: number;
let phaseSeq: number;
let initId: number;
let taskId: number;
let taskSeq: number;

beforeEach(async () => {
  db = await createTestDb();
  store = createSqliteStore(db);
  const p = await createProject(store, { key: 'MMR', name: 'Mimir' });
  const init = await createInitiative(store, { projectId: p.id, title: 'Initiative' });
  initId = init.id;
  const phase = await createPhase(store, { parentId: init.id, title: 'Phase' });
  phaseId = phase.id;
  phaseSeq = phase.seq;
  const task = await createTask(store, { parentId: phase.id, title: 'Ready Task' });
  taskId = task.id;
  taskSeq = task.seq;
});
afterEach(async () => {
  await db.destroy();
});

/** Capture an awaited rejection as a MimirError (or fail the assertion). */
async function caught(run: () => Promise<unknown>): Promise<MimirError> {
  try {
    await run();
  } catch (e) {
    if (e instanceof MimirError) {
      return e;
    }
    throw e;
  }
  throw new Error('expected a MimirError, but nothing was thrown');
}

/** Render an error to both human + machine sinks; return the captured stderr lines. */
function renderBoth(err: RenderableError): { human: string; machine: string } {
  const lines = (format: string): string => {
    const out: string[] = [];
    const io: Io = {
      error: (s) => out.push(s),
      isTTY: false,
      plain: true,
      write: () => {},
    };
    renderError(err, format, io);
    return out.join('\n');
  };
  return { human: lines('table'), machine: lines('json') };
}

// ─── Site A: Container lifecycle hint ────────────────────────────────────────

describe('Site A — container lifecycle hint', () => {
  test('starting a phase with ready descendants names their ids in the hint', async () => {
    const err = await caught(() => startTask(store, phaseId));
    expect(err.code).toBe('validation');
    expect(err.hint).toContain(`MMR-${String(taskSeq)}`);
    expect(err.hint).toContain("containers aren't started directly");

    // The hint reaches both renderings.
    const { human, machine } = renderBoth(err);
    expect(human).toContain('note:');
    expect(human).toContain(`MMR-${String(taskSeq)}`);
    const parsed = parseJson<{ error: { hint?: string } }>(machine);
    expect(parsed.error.hint).toContain(`MMR-${String(taskSeq)}`);
  });

  test('starting a phase with no ready descendants gets the mimir tree fallback hint', async () => {
    await startTask(store, taskId);
    await completeTask(store, taskId);

    const err = await caught(() => startTask(store, phaseId));
    expect(err.code).toBe('validation');
    expect(err.hint).toContain('no ready tasks under it');
    expect(err.hint).toContain(`mimir tree MMR-${String(phaseSeq)}`);

    const { human, machine } = renderBoth(err);
    expect(human).toContain('note:');
    expect(human).toContain('mimir tree');
    const parsed = parseJson<{ error: { hint?: string } }>(machine);
    expect(parsed.error.hint).toContain('mimir tree');
  });

  test('starting an initiative with ready tasks under it names their ids', async () => {
    const err = await caught(() => startTask(store, initId));
    expect(err.code).toBe('validation');
    expect(err.hint).toContain(`MMR-${String(taskSeq)}`);
  });
});

// ─── Site B: Missing project hint ───────────────────────────────────────────

const assertCreateHint = (err: MimirError): void => {
  expect(err.code).toBe('not_found');
  expect(err.hint).toContain('mimir create project');
  expect(err.hint).toContain('--key NOPE');
};

describe('Site B — missing project hint', () => {
  test('resolveEntityToken for an unknown project key carries the create hint (core/lookup)', async () => {
    const set = deriveSet(await store.loadWorkingSet());
    assertCreateHint(await caught(async () => resolveEntityTokenInSet(set, 'NOPE')));
  });

  test('projectTree for an unknown project key carries the create hint (core/resource)', async () => {
    assertCreateHint(await caught(() => projectTree(store, 'NOPE')));
  });

  test('resolveProject for an unknown key carries the create hint (cli/resolve)', async () => {
    const err = await caught(() => resolveProject(store, 'NOPE'));
    assertCreateHint(err);

    // The same hint reaches both renderings.
    const { human, machine } = renderBoth(err);
    expect(human).toContain('note:');
    expect(human).toContain('mimir create project');
    const parsed = parseJson<{ error: { hint?: string } }>(machine);
    expect(parsed.error.hint).toContain('mimir create project');
    expect(parsed.error.hint).toContain('--key NOPE');
  });

  test('nextTasks with unknown --scope key carries the create hint (core/intent/queries resolveScope)', async () => {
    const err = await caught(() => nextTasks(createSqliteStore(db), { scope: 'NOPE' }));
    assertCreateHint(err);

    // The hint reaches both renderings (previously this path threw a bare error).
    const { human, machine } = renderBoth(err);
    expect(human).toContain('note:');
    expect(human).toContain('mimir create project');
    const parsed = parseJson<{ error: { hint?: string } }>(machine);
    expect(parsed.error.hint).toContain('mimir create project');
    expect(parsed.error.hint).toContain('--key NOPE');
  });
});
