import { afterEach, beforeEach, expect, test } from 'bun:test';

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';

import { expectMimirError } from '../core/testing';
import { NornClient } from './client';
import { migrationPlan, setFrontmatter } from './plan';

/**
 * A fake norn: an in-process MCP server over a linked in-memory transport
 * pair. Each factory call is one "subprocess"; `crash()` closes the current
 * server — from between calls it's a dead subprocess, from inside a handler
 * it's an in-flight death (the response never arrives).
 */
type FakeTool = (args: Record<string, unknown>) => Promise<{
  structuredContent?: Record<string, unknown>;
  content?: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

const SHAPES: Record<string, z.ZodRawShape> = {
  'vault.apply': {
    confirm: z.boolean().optional(),
    parents: z.boolean().optional(),
    plan: z.record(z.string(), z.unknown()),
  },
  'vault.find': { eq: z.array(z.string()).optional() },
  'vault.get': {
    col: z.string().optional(),
    section: z.array(z.string()).optional(),
    targets: z.array(z.string()),
  },
  'vault.set': {
    body: z.string().optional(),
    confirm: z.boolean().optional(),
    // norn 0.47 (NRN-238): the map-shaped `set` param is retired; fields arrive
    // as ordered KEY=JSON tokens, the same shape `vault.new` takes.
    field_json: z.array(z.string()).optional(),
    remove: z.array(z.string()).optional(),
    target: z.string(),
  },
};

function fakeNorn(build: (crash: () => Promise<void>) => Record<string, FakeTool>) {
  let current: McpServer | null = null;
  let spawns = 0;
  const crash = async (): Promise<void> => {
    await current?.close();
  };
  const factory = async (): Promise<Transport> => {
    spawns += 1;
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = new McpServer({ name: 'fake-norn', version: '0' });
    for (const [name, handler] of Object.entries(build(crash))) {
      server.registerTool(
        name,
        { inputSchema: SHAPES[name] ?? {} },
        async (args: Record<string, unknown>) => {
          const out = await handler(args);
          return { content: out.content ?? [], ...out };
        },
      );
    }
    await server.connect(serverSide);
    current = server;
    return clientSide;
  };
  return {
    crash,
    factory,
    get spawns() {
      return spawns;
    },
  };
}

/** A factory whose spawn always fails — the missing/broken norn binary. */
const brokenSpawn = () => Promise.reject(new Error('spawn norn ENOENT'));

let client: NornClient | null = null;
beforeEach(() => {
  client = null;
});
afterEach(async () => {
  await client?.close();
});

test('find unwraps structuredContent and shape-checks the documents array', async () => {
  const fake = fakeNorn(() => ({
    'vault.find': () =>
      Promise.resolve({ structuredContent: { documents: [{ path: 'MMR/artifacts/MMR-a1.md' }] } }),
  }));
  client = new NornClient({ transportFactory: fake.factory, vaultPath: '/unused' });
  const docs = await client.find({ eq: ['type:artifact'] });
  expect(docs).toEqual([{ path: 'MMR/artifacts/MMR-a1.md' }]);
  expect(fake.spawns).toBe(1); // lazy: exactly one connect for the call
});

test('a missing documents array is an invariant, not a silent empty result', async () => {
  const fake = fakeNorn(() => ({
    'vault.find': () => Promise.resolve({ structuredContent: { wrong: true } }),
  }));
  client = new NornClient({ transportFactory: fake.factory, vaultPath: '/unused' });
  await expectMimirError('invariant', () => (client as NornClient).find({}));
});

test('an isError result raises a validation error carrying norn message', async () => {
  const fake = fakeNorn(() => ({
    'vault.set': () =>
      Promise.resolve({
        content: [{ text: 'target not found', type: 'text' as const }],
        isError: true,
      }),
  }));
  client = new NornClient({ transportFactory: fake.factory, vaultPath: '/unused' });
  await expectMimirError('validation', () =>
    (client as NornClient).set({ confirm: true, set: { a: 1 }, target: 'x.md' }),
  );
});

test('set serializes the record into ordered field_json KEY=JSON tokens (norn 0.47)', async () => {
  // NRN-238: the map-shaped `set` param is retired (norn silently ignores it);
  // the wire carries `field_json` tokens — the exact serialization is the contract.
  let received: unknown = null;
  const fake = fakeNorn(() => ({
    'vault.set': (args) => {
      received = args;
      return Promise.resolve({ structuredContent: { ok: true } });
    },
  }));
  client = new NornClient({ transportFactory: fake.factory, vaultPath: '/unused' });
  await client.set({ confirm: true, set: { tags: ['a', 'b'], title: 'After' }, target: 'x.md' });
  expect(received).toEqual({
    confirm: true,
    field_json: ['tags=["a","b"]', 'title="After"'],
    target: 'x.md',
  });
});

test('calls are serialized: a slow call blocks the next, never pipelined', async () => {
  let inFlight = 0;
  let overlapped = false;
  const order: string[] = [];
  const fake = fakeNorn(() => ({
    'vault.find': async (args) => {
      inFlight += 1;
      if (inFlight > 1) {
        overlapped = true;
      }
      await Bun.sleep(20);
      order.push(String((args.eq as string[])[0]));
      inFlight -= 1;
      return { structuredContent: { documents: [] } };
    },
  }));
  client = new NornClient({ transportFactory: fake.factory, vaultPath: '/unused' });
  await Promise.all([
    client.find({ eq: ['first'] }),
    client.find({ eq: ['second'] }),
    client.find({ eq: ['third'] }),
  ]);
  expect(overlapped).toBe(false);
  expect(order).toEqual(['first', 'second', 'third']);
});

test('a subprocess dead between calls is respawned lazily on the next call', async () => {
  const fake = fakeNorn(() => ({
    'vault.find': () => Promise.resolve({ structuredContent: { documents: [] } }),
  }));
  client = new NornClient({ transportFactory: fake.factory, vaultPath: '/unused' });
  await client.find({});
  expect(fake.spawns).toBe(1);

  await fake.crash(); // dies while idle
  expect(await client.find({})).toEqual([]); // next call reconnects
  expect(fake.spawns).toBe(2);
});

test('an in-flight death on a read is retried once, transparently', async () => {
  let invocations = 0;
  const fake = fakeNorn((crash) => ({
    'vault.find': async () => {
      invocations += 1;
      if (invocations === 1) {
        await crash(); // the response never arrives
      }
      return { structuredContent: { documents: [{ path: 'ok.md' }] } };
    },
  }));
  client = new NornClient({ transportFactory: fake.factory, vaultPath: '/unused' });
  const docs = await client.find({});
  expect(docs).toEqual([{ path: 'ok.md' }]);
  expect(invocations).toBe(2);
  expect(fake.spawns).toBe(2);
});

test('an in-flight death on a mutation fails typed and is never replayed', async () => {
  let applied = 0;
  const fake = fakeNorn((crash) => ({
    'vault.set': async () => {
      applied += 1;
      if (applied === 1) {
        await crash(); // the confirm may or may not have landed — ambiguous
      }
      return { structuredContent: { ok: true } };
    },
  }));
  client = new NornClient({ transportFactory: fake.factory, vaultPath: '/unused' });
  await expectMimirError('invariant', () =>
    (client as NornClient).set({ confirm: true, set: { a: 1 }, target: 'x.md' }),
  );
  expect(applied).toBe(1); // NOT replayed

  await client.set({ set: { a: 2 }, target: 'x.md' }); // the next call reconnects
  expect(applied).toBe(2);
  expect(fake.spawns).toBe(2);
});

test('applyPlan sends vault.apply with {plan, confirm, parents} and unwraps the report', async () => {
  let received: unknown = null;
  const fake = fakeNorn(() => ({
    'vault.apply': (args) => {
      received = args;
      return Promise.resolve({ structuredContent: { report: { applied: 1, dry_run: false } } });
    },
  }));
  client = new NornClient({ transportFactory: fake.factory, vaultPath: '/unused' });
  const plan = migrationPlan({
    operations: [setFrontmatter('MMR/MMR-1.md', 'lifecycle', 'done')],
    vaultRoot: '/vault',
  });
  const report = await client.applyPlan(plan, true);
  expect(report).toEqual({ report: { applied: 1, dry_run: false } });
  expect(received).toEqual({ confirm: true, parents: true, plan });
});

test('getSections sends vault.get with {targets, section} and returns the records array', async () => {
  let received: unknown = null;
  const fake = fakeNorn(() => ({
    'vault.get': (args) => {
      received = args;
      return Promise.resolve({
        structuredContent: {
          records: [{ path: 'MMR/MMR-1.md', sections: { History: '## History\n### x\n' } }],
          section_failures: [],
        },
      });
    },
  }));
  client = new NornClient({ transportFactory: fake.factory, vaultPath: '/unused' });
  const records = await client.getSections(['MMR-1'], ['History']);
  expect(received).toEqual({ section: ['History'], targets: ['MMR-1'] });
  expect(records).toEqual([{ path: 'MMR/MMR-1.md', sections: { History: '## History\n### x\n' } }]);
});

test('applyPlan returns the structured report even when isError is set (norn 0.45.1 refusal)', async () => {
  // NRN-219: a not-applied apply sets isError:true but PRESERVES the report, so
  // applyPlan must hand it back for runTransact to classify — never throw it away.
  const refused = {
    report: {
      applied: 0,
      failed: 1,
      operations: [
        {
          error: {
            code: 'expected-old-value-mismatch',
            message: 'stale repair plan for MMR/MMR-1.md',
            path: 'MMR/MMR-1.md',
          },
          kind: 'set_frontmatter',
          status: 'failed',
        },
      ],
      outcome: 'refused',
    },
  };
  const fake = fakeNorn(() => ({
    'vault.apply': () =>
      Promise.resolve({
        content: [{ text: 'stale repair plan for MMR/MMR-1.md', type: 'text' as const }],
        isError: true,
        structuredContent: refused,
      }),
  }));
  client = new NornClient({ transportFactory: fake.factory, vaultPath: '/unused' });
  const plan = migrationPlan({
    operations: [setFrontmatter('MMR/MMR-1.md', 'status', 'done')],
    vaultRoot: '/vault',
  });
  expect(await client.applyPlan(plan, true)).toEqual(refused);
});

test('applyPlan throws with norn message on an isError result that is not an apply report', async () => {
  // a genuine tool error may carry NO structuredContent, or a non-report envelope;
  // either way applyPlan must surface norn's diagnostic text, never swallow it into a
  // generic "unrecognized" classification (tolerate is scoped to a real `{ report }`).
  for (const structuredContent of [undefined, { detail: 'not a report', error: 'internal' }]) {
    const fake = fakeNorn(() => ({
      'vault.apply': () =>
        Promise.resolve({
          content: [{ text: 'plan schema invalid', type: 'text' as const }],
          isError: true,
          ...(structuredContent === undefined ? {} : { structuredContent }),
        }),
    }));
    client = new NornClient({ transportFactory: fake.factory, vaultPath: '/unused' });
    const plan = migrationPlan({ operations: [], vaultRoot: '/vault' });
    let message = '';
    try {
      await client.applyPlan(plan, true);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('plan schema invalid');
  }
});

test('a vault.get isError carrying the structured read payload is returned as data (norn 0.46)', async () => {
  // NRN-214: an unresolved target / all-headings-miss get sets isError:true but
  // PRESERVES records/section_failures/notes. The seams need that payload —
  // sectionFailures reports instead of aborting, get sees empty records.
  const fake = fakeNorn(() => ({
    'vault.get': () =>
      Promise.resolve({
        content: [{ text: 'did not resolve', type: 'text' as const }],
        isError: true,
        structuredContent: {
          notes: ["error: 'MMR/MMR-9.md' did not resolve to any doc"],
          records: [],
          section_failures: [{ path: 'MMR/MMR-1.md', requested_headings: ['Annotations'] }],
        },
      }),
  }));
  client = new NornClient({ transportFactory: fake.factory, vaultPath: '/unused' });
  expect(await client.get(['MMR-9'])).toEqual([]);
  expect(await client.sectionFailures(['MMR-1'], ['Annotations'])).toEqual(['MMR/MMR-1.md']);
});

test('a vault.get isError with no structured payload still throws validation', async () => {
  // The tolerance is scoped to a genuine read payload — a payload-less tool error
  // must surface norn's diagnostic text, never degrade to an empty read.
  const fake = fakeNorn(() => ({
    'vault.get': () =>
      Promise.resolve({
        content: [{ text: 'vault is locked', type: 'text' as const }],
        isError: true,
      }),
  }));
  client = new NornClient({ transportFactory: fake.factory, vaultPath: '/unused' });
  await expectMimirError('validation', () => (client as NornClient).get(['MMR-1']));
  let message = '';
  try {
    await client.get(['MMR-1']);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain('vault is locked');
});

test('the isError read tolerance is scoped to vault.get — other tools still throw', async () => {
  // A records-shaped payload on a DIFFERENT tool must not slip through as data.
  const fake = fakeNorn(() => ({
    'vault.find': () =>
      Promise.resolve({
        content: [{ text: 'find rejected', type: 'text' as const }],
        isError: true,
        structuredContent: { records: [] },
      }),
  }));
  client = new NornClient({ transportFactory: fake.factory, vaultPath: '/unused' });
  let message = '';
  try {
    await client.find({});
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain('find rejected');
});

test('an in-flight death on applyPlan fails typed and is never replayed', async () => {
  let applied = 0;
  const fake = fakeNorn((crash) => ({
    'vault.apply': async () => {
      applied += 1;
      if (applied === 1) {
        await crash(); // the batch may or may not have landed — ambiguous
      }
      return { structuredContent: { report: {} } };
    },
  }));
  client = new NornClient({ transportFactory: fake.factory, vaultPath: '/unused' });
  const plan = migrationPlan({ operations: [], vaultRoot: '/vault' });
  await expectMimirError('invariant', () => (client as NornClient).applyPlan(plan, true));
  expect(applied).toBe(1); // NOT replayed
});

test('close shuts the session; the next call lazily reconnects', async () => {
  const fake = fakeNorn(() => ({
    'vault.find': () => Promise.resolve({ structuredContent: { documents: [] } }),
  }));
  client = new NornClient({ transportFactory: fake.factory, vaultPath: '/unused' });
  await client.find({});
  await client.close();
  await client.find({});
  expect(fake.spawns).toBe(2);
});

test('a call-level failure closes the still-alive session — no orphaned subprocess', async () => {
  let transportCloses = 0;
  const fake = fakeNorn(() => ({
    'vault.find': async () => {
      await Bun.sleep(50); // outlives the client timeout below
      return { structuredContent: { documents: [] } };
    },
  }));
  const spyFactory = async (): Promise<Transport> => {
    const transport = await fake.factory();
    const original = transport.close.bind(transport);
    transport.close = async () => {
      transportCloses += 1;
      await original();
    };
    return transport;
  };
  client = new NornClient({ timeoutMs: 10, transportFactory: spyFactory, vaultPath: '/unused' });
  await expectMimirError('invariant', () => (client as NornClient).find({}));
  // each timed-out attempt closed its (still-alive) session — the SDK may
  // close the transport again on its own path; double-close is idempotent
  expect(transportCloses).toBeGreaterThanOrEqual(2);
});

test('close is serialized behind an in-flight call — no subprocess outlives it', async () => {
  const fake = fakeNorn(() => ({
    'vault.find': async () => {
      await Bun.sleep(20);
      return { structuredContent: { documents: [{ path: 'ok.md' }] } };
    },
  }));
  client = new NornClient({ transportFactory: fake.factory, vaultPath: '/unused' });
  const inFlight = client.find({}); // starts the connect + call
  await client.close(); // must wait for the call, then close its session
  expect(await inFlight).toEqual([{ path: 'ok.md' }]); // the call completed first
  expect(fake.spawns).toBe(1); // and close did not strand or respawn anything
});

test('a read whose retry also fails throws typed, never a raw error', async () => {
  client = new NornClient({ transportFactory: brokenSpawn, vaultPath: '/unused' });
  await expectMimirError('invariant', () => (client as NornClient).find({}));
});
