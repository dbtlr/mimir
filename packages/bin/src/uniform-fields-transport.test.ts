import { afterEach, beforeEach, expect, test } from 'bun:test';

import { OP_FACTS } from '@mimir/contract';
import type { Server } from 'bun';

import { updateFieldFlags } from './cli/mutations';
import { runCli } from './cli/run';
import { fakeIo } from './cli/testing';
import {
  createInitiative,
  createPhase,
  createProject,
  createTask,
  deriveSet,
  findNodeInSet,
  specUpdateFields,
} from './core';
import type { SpecUpdateField, Store } from './core';
import { createServer } from './http/server';
import { toolUniform } from './mcp/tools';
import { createTestStore, nodeIdOf, projectIdOf } from './testing/store';

/**
 * The uniform-verb extra-args propagation pin (ADR 0026, MMR-320) — the verb
 * analogue of the field-transport application suite. `start` is the one uniform
 * verb that records data-plane fields at its transition, and it derives them from
 * the SAME field spec `update` derives from, so acceptance and application must
 * hold together on all three transports with no per-transport field list. This
 * drives every field the registry declares end-to-end through each real transport
 * and asserts the value lands on the node; a transport that advertises but drops
 * one turns this suite red.
 */

const NORN = Bun.which('norn') !== null;

/** The declared extra fields, resolved to their spec triples — the loop source. */
const START_FIELDS: readonly SpecUpdateField[] = specUpdateFields(OP_FACTS.start.fields ?? []);

let store: Store;
let closeStore: (() => Promise<void>) | undefined;
let server: Server<undefined>;
let base: string;
let phaseId: string;

beforeEach(async () => {
  if (!NORN) {
    return;
  }
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
  server = createServer(store, { port: 0, version: '0.0.0-test' });
  base = `http://127.0.0.1:${String(server.port)}`;
});

afterEach(async () => {
  await server?.stop(true);
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
  expect(await runCli(['start', ref, flag, value], () => store, fakeIo(false))).toBe(0);
};

const httpStart: Driver = async (ref, field, value) => {
  const res = await fetch(`${base}/api/nodes/${ref}/start`, {
    body: JSON.stringify({ [field.key]: value }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  expect(res.status).toBe(200);
};

const mcpStart: Driver = async (ref, field, value) => {
  const res = await toolUniform(store, 'start', { id: ref, [field.update]: value });
  expect(res.isError).toBeUndefined();
};

const DRIVERS: [name: string, drive: Driver][] = [
  ['cli', cliStart],
  ['http', httpStart],
  ['mcp', mcpStart],
];

// Guard: the registry declares extra fields at all, so the generated cases below
// can't go silently vacuous.
test('start declares at least one extra data-plane field', () => {
  expect(START_FIELDS.length).toBeGreaterThan(0);
});

for (const field of START_FIELDS) {
  for (const [name, drive] of DRIVERS) {
    test.skipIf(!NORN)(`${name} start applies ${field.key} onto the claimed task`, async () => {
      const ref = await freshTask();
      const value = `claim-${field.key}`;
      await drive(ref, field, value);
      expect(await landedValue(ref, field)).toEqual(value);
    });
  }
}

test.skipIf(!NORN)('HTTP refuses an extra field on a verb that declares none', async () => {
  const ref = await freshTask();
  await runCli(['start', ref], () => store, fakeIo(false));
  const res = await fetch(`${base}/api/nodes/${ref}/submit`, {
    body: JSON.stringify({ host: 'workbench.local' }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  // The allow-list is derived per verb, so `submit` (no declared fields) rejects
  // the key outright rather than silently swallowing it.
  expect(res.status).toBe(400);
});

test.skipIf(!NORN)('the CLI start echo is unchanged by the handle flags', async () => {
  const ref = await freshTask();
  const io = fakeIo(true);
  expect(await runCli(['start', ref, '--host', 'workbench.local'], () => store, io)).toBe(0);
  expect(io.out.join('\n')).toContain(`started ${ref} · todo -> in_progress`);
});
