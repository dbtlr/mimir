import { afterEach, beforeEach, expect, test } from 'bun:test';

import type { NodeType } from '@mimir/contract';
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
  FIELD_SPEC,
  fileSeed,
  findNodeInSet,
  SPEC_UPDATE_FIELDS,
} from './core';
import type { SpecUpdateField, Store } from './core';
import { createServer } from './http/server';
import { toolUpdate } from './mcp/tools';
import { createTestStore, nodeIdOf, projectIdOf } from './testing/store';

/**
 * The route-level propagation pin (ADR 0025, MMR-315): deriving only the ACCEPTED
 * field set on each transport leaves an accept-without-apply gap — a field a
 * transport advertises and lets through but never writes. This drives every
 * generic-`update` spec field end-to-end through each real transport (the CLI via
 * `runCli`, HTTP via a live loopback server, MCP via `toolUpdate` over a real
 * store) and asserts the value actually lands on the node. A future spec field
 * with an existing kind must land on all three with zero transport edits; a
 * transport that accepts-but-drops it turns this suite red.
 */

const NORN = Bun.which('norn') !== null;

let store: Store;
let closeStore: (() => Promise<void>) | undefined;
let server: Server<undefined>;
let base: string;
let projectId: string;
let initiativeId: string;
let phaseId: string;
let seedId: string;

beforeEach(async () => {
  if (!NORN) {
    return;
  }
  ({ close: closeStore, store } = await createTestStore());
  await createProject(store, { key: 'MMR', name: 'Mimir' });
  projectId = await projectIdOf(store, 'MMR');
  const init = await createInitiative(store, { projectId, title: 'init' });
  initiativeId = await nodeIdOf(store, `MMR-${String(init.seq)}`);
  const phase = await createPhase(store, { parentId: initiativeId, title: 'phase' });
  phaseId = await nodeIdOf(store, `MMR-${String(phase.seq)}`);
  // A real seed backs the `seed-ref` kind's wire value (`upstream`).
  const seed = await fileSeed(store, {
    kind: 'idea',
    project: 'MMR',
    requester: null,
    title: 'a seed',
  });
  seedId = seed.id;
  server = createServer(store, { port: 0, version: '0.0.0-test' });
  base = `http://127.0.0.1:${String(server.port)}`;
});

afterEach(async () => {
  await server?.stop(true);
  await closeStore?.();
});

/** Create a fresh leaf node of `type` under the shared fixture, returning its ref. */
async function freshNode(type: NodeType): Promise<string> {
  if (type === 'task') {
    const task = await createTask(store, { parentId: phaseId, title: 't' });
    return `MMR-${String(task.seq)}`;
  }
  if (type === 'phase') {
    const phase = await createPhase(store, { parentId: initiativeId, title: 'p' });
    return `MMR-${String(phase.seq)}`;
  }
  const init = await createInitiative(store, { projectId, title: 'i' });
  return `MMR-${String(init.seq)}`;
}

/** A valid wire value per field kind (mirrors the codec round-trip generators),
 * plus the value it should land as on the node. */
function wireFor(field: SpecUpdateField): { native: string | boolean; expected: string | boolean } {
  switch (field.kind) {
    case 'bool': {
      return { expected: true, native: true };
    }
    case 'enum:priority': {
      return { expected: 'p1', native: 'p1' };
    }
    case 'enum:size': {
      return { expected: 'medium', native: 'medium' };
    }
    case 'seed-ref': {
      return { expected: seedId, native: seedId };
    }
    case 'string': {
      return { expected: `wire-${field.key}`, native: `wire-${field.key}` };
    }
    default: {
      throw new Error(`no wire generator for kind ${field.kind}`);
    }
  }
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

type Driver = (ref: string, field: SpecUpdateField, native: string | boolean) => Promise<void>;

const cliUpdate: Driver = async (ref, field, native) => {
  const [, flag] = updateFieldFlags(field.update)[0] ?? [];
  if (flag === undefined) {
    throw new Error(`no CLI flag for ${field.update}`);
  }
  // A bool is a bare flag (its `true` face); every other kind takes a value token.
  const argv =
    field.kind === 'bool' ? ['update', ref, flag] : ['update', ref, flag, String(native)];
  const code = await runCli(argv, () => store, fakeIo(false));
  expect(code).toBe(0);
};

const httpUpdate: Driver = async (ref, field, native) => {
  const res = await fetch(`${base}/api/nodes/${ref}`, {
    body: JSON.stringify({ [field.key]: native }),
    headers: { 'content-type': 'application/json' },
    method: 'PATCH',
  });
  expect(res.status).toBe(200);
};

const mcpUpdate: Driver = async (ref, field, native) => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const args = { id: ref, [field.update]: native } as Parameters<typeof toolUpdate>[1];
  const res = await toolUpdate(store, args);
  expect(res.isError).toBeUndefined();
};

const DRIVERS: [name: string, drive: Driver][] = [
  ['cli', cliUpdate],
  ['http', httpUpdate],
  ['mcp', mcpUpdate],
];

// Guard: the field set is non-empty, so an empty SPEC_UPDATE_FIELDS can't make the
// generated cases below silently vacuous.
test('the spec advertises at least one generic-update field', () => {
  expect(SPEC_UPDATE_FIELDS.length).toBeGreaterThan(0);
});

for (const field of SPEC_UPDATE_FIELDS) {
  const type = FIELD_SPEC[field.key].appliesTo[0];
  for (const [name, drive] of DRIVERS) {
    test.skipIf(!NORN)(`${name} update applies ${field.key} onto a ${type ?? '?'}`, async () => {
      if (type === undefined) {
        throw new Error(`spec field ${field.key} applies to no node type`);
      }
      const ref = await freshNode(type);
      const { expected, native } = wireFor(field);
      await drive(ref, field, native);
      expect(await landedValue(ref, field)).toEqual(expected);
    });
  }
}
