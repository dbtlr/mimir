import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { OP_FACTS } from '@mimir/contract';
import {
  createInitiative,
  createPhase,
  createProject,
  createTask,
  deriveSet,
  findNodeInSet,
  specUpdateFields,
} from '@mimir/core';
import type { SpecUpdateField, Store } from '@mimir/core';
import { createTestStore, nodeIdOf, projectIdOf } from '@mimir/core/testing';

import { updateFieldFlags } from './cli/mutations';
import { runCli } from './cli/run';
import { fakeIo } from './cli/testing';
import { toolUniform } from './mcp/tools';

/**
 * The uniform-verb extra-args propagation pin (ADR 0026, MMR-320) — the verb
 * analogue of the field-transport application suite. `start` is the one uniform
 * verb that records data-plane fields at its transition, and it derives them from
 * the SAME field spec `update` derives from, so acceptance and application must
 * hold together on the CLI and MCP with no per-transport field list. This
 * drives every field the registry declares end-to-end through each transport
 * and asserts the value lands on the node; a transport that advertises but drops
 * one turns this suite red.
 */

/** The declared extra fields, resolved to their spec triples — the loop source. */
const START_FIELDS: readonly SpecUpdateField[] = specUpdateFields(OP_FACTS.start.fields ?? []);

let store: Store;
let closeStore: (() => Promise<void>) | undefined;
let phaseId: string;

beforeEach(async () => {
  ({ close: closeStore, store } = await createTestStore());
  await createProject(store, { key: 'MMR', name: 'Mimir' });
  const init = await createInitiative(store, {
    projectId: await projectIdOf(store, 'MMR'),
    title: 'init',
  });
  const phase = await createPhase(store, {
    parentId: await nodeIdOf(store, `MMR-${String(init.seq)}`),
    title: 'phase',
  });
  phaseId = await nodeIdOf(store, `MMR-${String(phase.seq)}`);
});

afterEach(async () => {
  await closeStore?.();
});

/** A fresh todo task under the shared fixture, returned as its `KEY-seq` ref. */
async function freshTask(): Promise<string> {
  const task = await createTask(store, { parentId: phaseId, title: 't' });
  return `MMR-${String(task.seq)}`;
}

/** Read the landed data-plane value back off the node via the working set. */
async function landedValue(ref: string, field: SpecUpdateField): Promise<unknown> {
  const node = findNodeInSet(deriveSet(await store.loadWorkingSet()), ref);
  if (node === undefined) {
    throw new Error(`no node ${ref}`);
  }
  // The Node model keys its data plane by the snake_case DataFieldKey.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (node as unknown as Record<string, unknown>)[field.key];
}

type Driver = (ref: string, field: SpecUpdateField, value: string) => Promise<void>;

const cliStart: Driver = async (ref, field, value) => {
  const [, flag] = updateFieldFlags(field.update)[0] ?? [];
  if (flag === undefined) {
    throw new Error(`no CLI flag for ${field.update}`);
  }
  const prerequisites: string[] = [];
  if (field.key === 'worker_harness' || field.key === 'worker_session') {
    prerequisites.push('--session', 'main-session');
  }
  if (field.key === 'worker_harness') {
    prerequisites.push('--worker-session', 'worker-session');
  }
  expect(
    await runCli(['start', ref, flag, value, ...prerequisites], () => store, fakeIo(false)),
  ).toBe(0);
};

const mcpStart: Driver = async (ref, field, value) => {
  const prerequisites: { session?: string; workerSession?: string } = {};
  if (field.key === 'worker_harness' || field.key === 'worker_session') {
    prerequisites.session = 'main-session';
  }
  if (field.key === 'worker_harness') {
    prerequisites.workerSession = 'worker-session';
  }
  const res = await toolUniform(store, 'start', {
    id: ref,
    [field.update]: value,
    ...prerequisites,
  });
  expect(res.isError).toBeUndefined();
};

const DRIVERS: [name: string, drive: Driver][] = [
  ['cli', cliStart],
  ['mcp', mcpStart],
];

// Guard: the registry declares extra fields at all, so the generated cases below
// can't go silently vacuous.
test('start declares at least one extra data-plane field', () => {
  expect(START_FIELDS.length).toBeGreaterThan(0);
});

describe.each([...START_FIELDS])('start field $key', (field) => {
  test.each(DRIVERS)(
    `%s start applies ${field.key} onto the claimed task`,
    async (_name, drive) => {
      const ref = await freshTask();
      const value = `claim-${field.key}`;
      await drive(ref, field, value);
      expect(await landedValue(ref, field)).toEqual(value);
    },
  );
});

test('the CLI start echo is unchanged by the handle flags', async () => {
  const ref = await freshTask();
  const io = fakeIo(true);
  expect(await runCli(['start', ref, '--host', 'workbench.local'], () => store, io)).toBe(0);
  expect(io.out.join('\n')).toContain(`started ${ref} · todo -> in_progress`);
});
