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
import { resolveProject } from '../cli/resolve';
import type { Io } from '../presentation';
import { createTestStore, nodeIdOf, projectIdOf } from '../testing/store';
import { createInitiative, createPhase, createProject, createTask } from './create';
import { deriveSet } from './derive';
import { MimirError } from './errors';
import { nextTasks } from './intent/queries';
import { completeTask, startTask } from './mutations';
import { resolveEntityTokenInSet } from './resolve-set';
import { projectTree } from './resource';
import type { Store } from './store';

const NORN = Bun.which('norn') !== null;

let store: Store;
let closeStore: () => Promise<void>;
let phaseId: string;
let phaseSeq: number;
let initId: string;
let taskId: string;
let taskSeq: number;

beforeEach(async () => {
  ({ close: closeStore, store } = await createTestStore());
  await createProject(store, { key: 'MMR', name: 'Mimir' });
  const projectId = await projectIdOf(store, 'MMR');
  const init = await createInitiative(store, { projectId, title: 'Initiative' });
  initId = await nodeIdOf(store, `MMR-${String(init.seq)}`);
  const phase = await createPhase(store, { parentId: initId, title: 'Phase' });
  phaseId = await nodeIdOf(store, `MMR-${String(phase.seq)}`);
  phaseSeq = phase.seq;
  const task = await createTask(store, { parentId: phaseId, title: 'Ready Task' });
  taskId = await nodeIdOf(store, `MMR-${String(task.seq)}`);
  taskSeq = task.seq;
});
afterEach(async () => {
  await closeStore();
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
  test.skipIf(!NORN)(
    'starting a phase with ready descendants names their ids in the hint',
    async () => {
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
    },
  );

  test.skipIf(!NORN)(
    'starting a phase with no ready descendants gets the mimir tree fallback hint',
    async () => {
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
    },
  );

  test.skipIf(!NORN)(
    'starting an initiative with ready tasks under it names their ids',
    async () => {
      const err = await caught(() => startTask(store, initId));
      expect(err.code).toBe('validation');
      expect(err.hint).toContain(`MMR-${String(taskSeq)}`);
    },
  );
});

// ─── Site B: Missing project hint ───────────────────────────────────────────

const assertCreateHint = (err: MimirError): void => {
  expect(err.code).toBe('not_found');
  expect(err.hint).toContain('mimir create project');
  expect(err.hint).toContain('--key NOPE');
};

describe('Site B — missing project hint', () => {
  test.skipIf(!NORN)(
    'resolveEntityToken for an unknown project key carries the create hint (core/lookup)',
    async () => {
      const set = deriveSet(await store.loadWorkingSet());
      assertCreateHint(await caught(async () => resolveEntityTokenInSet(set, 'NOPE')));
    },
  );

  test.skipIf(!NORN)(
    'projectTree for an unknown project key carries the create hint (core/resource)',
    async () => {
      assertCreateHint(await caught(() => projectTree(store, 'NOPE')));
    },
  );

  test.skipIf(!NORN)(
    'resolveProject for an unknown key carries the create hint (cli/resolve)',
    async () => {
      const err = await caught(() => resolveProject(store, 'NOPE'));
      assertCreateHint(err);

      // The same hint reaches both renderings.
      const { human, machine } = renderBoth(err);
      expect(human).toContain('note:');
      expect(human).toContain('mimir create project');
      const parsed = parseJson<{ error: { hint?: string } }>(machine);
      expect(parsed.error.hint).toContain('mimir create project');
      expect(parsed.error.hint).toContain('--key NOPE');
    },
  );

  test.skipIf(!NORN)(
    'nextTasks with unknown --scope key carries the create hint (core/intent/queries resolveScope)',
    async () => {
      const err = await caught(() => nextTasks(store, { scope: 'NOPE' }));
      assertCreateHint(err);

      // The hint reaches both renderings (previously this path threw a bare error).
      const { human, machine } = renderBoth(err);
      expect(human).toContain('note:');
      expect(human).toContain('mimir create project');
      const parsed = parseJson<{ error: { hint?: string } }>(machine);
      expect(parsed.error.hint).toContain('mimir create project');
      expect(parsed.error.hint).toContain('--key NOPE');
    },
  );
});
