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
    plan: z.record(z.string(), z.unknown()),
  },
  'vault.find': { eq: z.array(z.string()).optional() },
  'vault.set': {
    confirm: z.boolean().optional(),
    set: z.record(z.string(), z.unknown()).optional(),
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

test('applyPlan sends vault.apply with {plan, confirm} and unwraps the report', async () => {
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
  expect(received).toEqual({ confirm: true, plan });
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

test('applyPlan still throws on an isError result with no structured report', async () => {
  // a genuine tool error (e.g. an unparseable plan) carries no report → terminal throw
  const fake = fakeNorn(() => ({
    'vault.apply': () =>
      Promise.resolve({
        content: [{ text: 'plan schema invalid', type: 'text' as const }],
        isError: true,
      }),
  }));
  client = new NornClient({ transportFactory: fake.factory, vaultPath: '/unused' });
  const plan = migrationPlan({ operations: [], vaultRoot: '/vault' });
  await expectMimirError('validation', () => (client as NornClient).applyPlan(plan, true));
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
