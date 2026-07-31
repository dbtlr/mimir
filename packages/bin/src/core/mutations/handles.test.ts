import { afterEach, beforeEach, expect, test } from 'bun:test';

import { HANDLE_FIELD_KEYS } from '@mimir/contract';
import type { ExecutionHandles } from '@mimir/contract';

import { nodeIdOf, projectIdOf, createTestStore } from '../../testing/store';
import { createInitiative, createPhase, createProject, createTask } from '../create';
import type { Node } from '../model';
import type { Store } from '../store';
import { expectMimirError } from '../testing';
import {
  abandonTask,
  blockTask,
  completeTask,
  parkTask,
  reopenTask,
  returnTask,
  startTask,
  submitTask,
  unblockTask,
  unparkTask,
  updateNode,
} from './index';

/**
 * The resume-handle lifecycle (ADR 0026 Decision 3, MMR-320): `start` stamps the
 * claim, a plain `update` overwrites it (there is no claim verb — resume and
 * takeover are the same ordinary patch), the terminal transitions and the holds
 * clear it, and `submit`/`return` keep it because the branch and session stay
 * the live pointers at the human gate. Each boundary echoes what it moved onto
 * the `## History` row, so claim succession survives in the append-only log.
 */

const NORN = Bun.which('norn') !== null;

let store: Store;
let closeStore: () => Promise<void>;
let phaseStem: string;

const CLAIM = {
  branch: 'feat/mmr-320',
  harness: 'codex',
  host: 'workbench.local',
  session: 's-01J8ABCD',
};

beforeEach(async () => {
  ({ close: closeStore, store } = await createTestStore());
  await createProject(store, { key: 'MMR', name: 'm' });
  const init = await createInitiative(store, {
    projectId: await projectIdOf(store, 'MMR'),
    title: 'i',
  });
  const phase = await createPhase(store, {
    parentId: await nodeIdOf(store, `MMR-${String(init.seq)}`),
    title: 'ph',
  });
  phaseStem = `MMR-${String(phase.seq)}`;
});
afterEach(async () => {
  await closeStore();
});

async function task(): Promise<string> {
  const t = await createTask(store, {
    parentId: await nodeIdOf(store, phaseStem),
    title: 't',
  });
  return nodeIdOf(store, `MMR-${String(t.seq)}`);
}

/** The handles a node currently carries, omit-when-absent. */
function handlesOn(node: Node): ExecutionHandles {
  const out: ExecutionHandles = {};
  for (const key of HANDLE_FIELD_KEYS) {
    const value = node[key];
    if (value !== null) {
      out[key] = value;
    }
  }
  return out;
}

/** The handle echoes on a node's `## History` rows, in document order. */
async function historyHandles(id: string): Promise<(ExecutionHandles | undefined)[]> {
  return (await store.bodySections.readHistory(id)).map((entry) => entry.handles);
}

test.skipIf(!NORN)('start records the handles and echoes them on the claim row', async () => {
  const id = await task();
  const started = await startTask(store, id, CLAIM);
  expect(handlesOn(started)).toEqual(CLAIM);
  expect(await historyHandles(id)).toEqual([CLAIM]);
});

test.skipIf(!NORN)('start without handles leaves them absent and echoes nothing', async () => {
  const id = await task();
  expect(handlesOn(await startTask(store, id))).toEqual({});
  expect(await historyHandles(id)).toEqual([undefined]);
});

test.skipIf(!NORN)('a partial claim records only the handles that were given', async () => {
  const id = await task();
  const started = await startTask(store, id, { session: 's-1' });
  expect(handlesOn(started)).toEqual({ session: 's-1' });
  expect(await historyHandles(id)).toEqual([{ session: 's-1' }]);
});

test.skipIf(!NORN)('update overwrites a handle — resume and takeover need no verb', async () => {
  const id = await task();
  await startTask(store, id, CLAIM);
  const taken = await updateNode(store, id, { host: 'other.local', session: 's-NEXT' });
  expect(handlesOn(taken)).toEqual({ ...CLAIM, host: 'other.local', session: 's-NEXT' });
  // An update is not a transition — it writes no History row (ADR 0003).
  expect(await historyHandles(id)).toEqual([CLAIM]);
});

test.skipIf(!NORN)('update clears one handle with a blank, leaving the rest', async () => {
  const id = await task();
  await startTask(store, id, CLAIM);
  const cleared = await updateNode(store, id, { session: '  ' });
  expect(cleared.session).toBeNull();
  expect(cleared.branch).toBe(CLAIM.branch);
});

test.skipIf(!NORN)('update normalizes a multi-line handle onto one line', async () => {
  const id = await task();
  const patched = await updateNode(store, id, { branch: '  feat/x\nstray  ' });
  expect(patched.branch).toBe('feat/x stray');
});

test.skipIf(!NORN)('the handles apply only to tasks', async () => {
  await expectMimirError('validation', () =>
    updateNode(store, phaseStem, { host: 'workbench.local' }),
  );
});

test.skipIf(!NORN)('done clears the handles and echoes what it cleared', async () => {
  const id = await task();
  await startTask(store, id, CLAIM);
  expect(handlesOn(await completeTask(store, id))).toEqual({});
  expect(await historyHandles(id)).toEqual([CLAIM, CLAIM]);
});

test.skipIf(!NORN)('abandon clears the handles and echoes what it cleared', async () => {
  const id = await task();
  await startTask(store, id, CLAIM);
  expect(handlesOn(await abandonTask(store, id, 'scope cut'))).toEqual({});
  expect(await historyHandles(id)).toEqual([CLAIM, CLAIM]);
});

test.skipIf(!NORN)('park clears the handles and echoes what it cleared', async () => {
  const id = await task();
  await startTask(store, id, CLAIM);
  expect(handlesOn(await parkTask(store, id, 'later'))).toEqual({});
  expect(await historyHandles(id)).toEqual([CLAIM, CLAIM]);
});

test.skipIf(!NORN)('block clears the handles and echoes what it cleared', async () => {
  const id = await task();
  await startTask(store, id, CLAIM);
  expect(handlesOn(await blockTask(store, id, 'upstream down'))).toEqual({});
  expect(await historyHandles(id)).toEqual([CLAIM, CLAIM]);
});

test.skipIf(!NORN)('a clearing transition on an unclaimed task echoes nothing', async () => {
  const id = await task();
  await startTask(store, id);
  await completeTask(store, id);
  expect(await historyHandles(id)).toEqual([undefined, undefined]);
});

test.skipIf(!NORN)('submit and return KEEP the handles through the human gate', async () => {
  const id = await task();
  await startTask(store, id, CLAIM);
  expect(handlesOn(await submitTask(store, id))).toEqual(CLAIM);
  expect(handlesOn(await returnTask(store, id, 'needs tests'))).toEqual(CLAIM);
  // Neither row moved a handle, so neither echoes one.
  expect(await historyHandles(id)).toEqual([CLAIM, undefined, undefined]);
});

test.skipIf(!NORN)('unpark and unblock restore nothing — a resume re-states them', async () => {
  const id = await task();
  await startTask(store, id, CLAIM);
  await parkTask(store, id, 'later');
  expect(handlesOn(await unparkTask(store, id))).toEqual({});
  await blockTask(store, id, 'upstream down');
  expect(handlesOn(await unblockTask(store, id))).toEqual({});
});

test.skipIf(!NORN)('reopen restores nothing — the claim is re-stated by update', async () => {
  const id = await task();
  await startTask(store, id, CLAIM);
  await completeTask(store, id);
  expect(handlesOn(await reopenTask(store, id, 'not actually done'))).toEqual({});
  expect(handlesOn(await updateNode(store, id, { session: 's-NEXT' }))).toEqual({
    session: 's-NEXT',
  });
});

test.skipIf(!NORN)('a claim survives the vault round trip verbatim', async () => {
  const id = await task();
  await startTask(store, id, CLAIM);
  const set = await store.loadWorkingSet();
  const reread = set.nodes.find((n) => n.id === id);
  expect(reread === undefined ? undefined : handlesOn(reread)).toEqual(CLAIM);
});
