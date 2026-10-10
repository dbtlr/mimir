import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { parseJson } from '@mimir/helpers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from 'bun';

import { runCli } from './cli/run';
import { fakeIo } from './cli/testing';
import { createInitiative, createProject, createTask, attachArtifact, depend } from './core';
import type { Store } from './core';
import { createServer } from './http/server';
import { buildMcpServer } from './mcp/server';
import { createTestStore } from './testing/store';

/**
 * Cross-record search (MMR-447) over the three transports: the same query must
 * return the same hits from the CLI (`-f json`), HTTP (`/api/search`), and MCP
 * (`search`), and each transport refuses bad input in its own grammar.
 *
 * The board: MMR-1 initiative, MMR-2 "Cross-record search" (depends on MMR-3,
 * described with "palette"), MMR-3 "Seed pages", MMR-a1 an artifact attached
 * to MMR-2, and NOR-1 so a bare number is ambiguous without a current project.
 */

let store: Store;
let closeStore: (() => Promise<void>) | undefined;
let server: Server<undefined>;
let base: string;

beforeAll(async () => {
  ({ close: closeStore, store } = await createTestStore());
  await createProject(store, { key: 'MMR', name: 'Mimir' });
  await createProject(store, { key: 'NOR', name: 'Norn' });
  const initiative = await createInitiative(store, { projectId: 'MMR', title: 'Console' });
  const search = await createTask(store, {
    description: 'The palette runs one query across every record.',
    parentId: initiative.id,
    title: 'Cross-record search',
  });
  const pages = await createTask(store, { parentId: initiative.id, title: 'Seed pages' });
  await depend(store, search.id, [pages.id]);
  await attachArtifact(store, {
    content: '# spec',
    linkNodeIds: [search.id],
    projectId: 'MMR',
    title: 'Search spec',
  });
  const norn = await createInitiative(store, { projectId: 'NOR', title: 'Knowledge' });
  await createTask(store, { parentId: norn.id, title: 'Vault' });

  server = createServer(store, { hunt: false, port: 0, version: '0.0.0-test' });
  base = `http://127.0.0.1:${String(server.port)}`;
});

afterAll(async () => {
  await server?.stop(true);
  await closeStore?.();
});

/** A store factory that fails the test if a verb opens the store. */
const neverStore = (): Store => {
  throw new Error('the store must not open');
};

type Hit = Record<string, unknown> & { id: string };

/** One query as each transport speaks it; `project` is the current project. */
type Query = { text: string; project?: string; limit?: number };

async function viaCli({ text, project, limit }: Query): Promise<Hit[]> {
  const io = fakeIo(false);
  const argv = ['search', text, '-f', 'json'];
  if (limit !== undefined) {
    argv.push('-n', String(limit));
  }
  argv.push('-s', project ?? 'all');
  expect(await runCli(argv, () => store, io)).toBe(0);
  return parseJson<{ results: Hit[] }>(io.out.join('')).results;
}

async function viaHttp({ text, project, limit }: Query): Promise<Hit[]> {
  const params = new URLSearchParams({ q: text });
  if (project !== undefined) {
    params.set('project', project);
  }
  if (limit !== undefined) {
    params.set('limit', String(limit));
  }
  const res = await fetch(`${base}/api/search?${params.toString()}`);
  expect(res.status).toBe(200);
  return parseJson<{ items: Hit[] }>(await res.text()).items;
}

type ToolCall = { isError?: boolean; content: { text?: string }[] };

async function callMcp(args: Record<string, unknown>): Promise<ToolCall> {
  const mcp = buildMcpServer(store, '0.0.0');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), mcp.connect(serverTransport)]);
  try {
    return (await client.callTool({ arguments: args, name: 'search' })) as ToolCall;
  } finally {
    await client.close();
  }
}

async function viaMcp({ text, project, limit }: Query): Promise<Hit[]> {
  const res = await callMcp({ limit, query: text, scope: project ?? 'all' });
  expect(res.isError).toBeUndefined();
  return parseJson<{ results: Hit[] }>(res.content[0]?.text ?? '').results;
}

describe('search parity', () => {
  // [name, query, the first hit, ids that must appear among the hits]
  const queries: [string, Query, string, string[]][] = [
    ['a full ID', { text: 'MMR-2' }, 'MMR-2', ['MMR-1', 'MMR-3', 'MMR-a1']],
    ['a bare number in the current project', { project: 'MMR', text: '2' }, 'MMR-2', ['MMR-3']],
    ['a bare number with no current project', { text: '2' }, 'MMR-2', ['NOR-2']],
    ['a title', { text: 'cross record' }, 'MMR-2', []],
    ['a description word', { text: 'palette' }, 'MMR-2', []],
    ['a limited ID query', { limit: 2, text: 'MMR-2' }, 'MMR-2', []],
  ];

  test.each(queries)('%s returns the same hits on all three', async (_n, query, first, has) => {
    const [cli, http, mcp] = [await viaCli(query), await viaHttp(query), await viaMcp(query)];
    const ids = cli.map((hit) => hit.id);
    expect(ids[0]).toBe(first);
    for (const id of has) {
      expect(ids).toContain(id);
    }
    expect(http).toEqual(cli);
    expect(mcp).toEqual(cli);
  });

  test('a limit caps the hits', async () => {
    expect(await viaCli({ limit: 2, text: 'MMR-2' })).toHaveLength(2);
  });

  test('a hit carries the snake_case wire fields, and link/snippet only where they apply', async () => {
    const [link] = (await viaHttp({ text: 'MMR-2' })).slice(1, 2);
    expect(Object.keys(link ?? {}).toSorted()).toEqual(
      [
        'finished',
        'id',
        'kind',
        'lifecycle',
        'link',
        'match',
        'project',
        'title',
        'updated_at',
      ].toSorted(),
    );
    const [description] = await viaHttp({ text: 'palette' });
    expect(description?.match).toBe('description');
    expect(typeof description?.snippet).toBe('string');
    expect(description).not.toHaveProperty('link');
  });
});

describe('CLI search', () => {
  test('no query is a usage error that never opens the store', async () => {
    const io = fakeIo(false);
    expect(await runCli(['search'], neverStore, io)).toBe(2);
    expect(io.err.join('')).toContain('search needs a query');
  });

  test('a limit outside 1 to 100 is a usage error', async () => {
    for (const limit of ['0', '101', 'x']) {
      expect(await runCli(['search', 'a', '-n', limit], neverStore, fakeIo(false))).toBe(2);
    }
  });

  test('several words join into one query, and the bound project is the current one', async () => {
    const io = fakeIo(false);
    expect(await runCli(['search', '3', '-f', 'ids'], () => store, io, { scope: 'MMR' })).toBe(0);
    expect(io.out.join('').split('\n')[0]).toBe('MMR-3');
    const words = fakeIo(false);
    expect(await runCli(['search', 'cross', 'record', '-f', 'ids'], () => store, words)).toBe(0);
    expect(words.out.join('')).toBe('MMR-2');
  });

  test('the human view names how each hit matched and indents description snippets', async () => {
    const io = fakeIo(true);
    expect(await runCli(['search', 'palette'], () => store, io)).toBe(0);
    const text = io.out.join('');
    expect(text).toContain('1 result');
    expect(text).toContain('MMR-2');
    expect(text).toContain('description');
    expect(text).toMatch(/\n {6}\S.*palette/i);
  });

  test('no match is an empty set at exit 0 with the reason on stderr', async () => {
    const io = fakeIo(false);
    expect(await runCli(['search', 'zzzzqq', '-f', 'json'], () => store, io)).toBe(0);
    expect(parseJson<{ results: unknown[]; total: number }>(io.out.join(''))).toMatchObject({
      results: [],
      total: 0,
    });
    expect(io.err.join('')).toContain("nothing matches 'zzzzqq'");
  });
});

describe('HTTP search', () => {
  test.each(['/api/search', '/api/search?q=', '/api/search?q=%20%20'])(
    'a missing or blank q is a 400 validation error (%s)',
    async (path) => {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(400);
      expect(parseJson<{ error: { code: string } }>(await res.text()).error.code).toBe(
        'validation',
      );
    },
  );

  test('a bad limit is a 400', async () => {
    for (const limit of ['0', 'x', '101']) {
      expect((await fetch(`${base}/api/search?q=a&limit=${limit}`)).status).toBe(400);
    }
  });

  test('returns the collection envelope', async () => {
    const res = await fetch(`${base}/api/search?q=MMR-2`);
    const body = parseJson<{ items: unknown[]; total: number }>(await res.text());
    expect(body.total).toBe(body.items.length);
    expect(body.total).toBeGreaterThan(1);
  });
});

describe('MCP search', () => {
  test('a missing query is rejected', async () => {
    const res = await callMcp({});
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('query');
  });

  test('a blank query is a validation error', async () => {
    const res = await callMcp({ query: '  ' });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('search needs a query');
  });

  test('the bound scope is the current project and "all" clears it', async () => {
    const mcp = buildMcpServer(store, '0.0.0', 'MMR');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([client.connect(clientTransport), mcp.connect(serverTransport)]);
    try {
      const ids = async (args: Record<string, unknown>): Promise<string[]> =>
        parseJson<{ results: Hit[] }>(
          ((await client.callTool({ arguments: args, name: 'search' })) as ToolCall).content[0]
            ?.text ?? '',
        ).results.map((hit) => hit.id);
      // Bound to MMR, the bare suffix resolves there alone.
      expect((await ids({ query: '2' }))[0]).toBe('MMR-2');
      expect(await ids({ query: '2' })).not.toContain('NOR-2');
      expect((await ids({ query: '2', scope: 'all' })).toSorted()).toEqual(['MMR-2', 'NOR-2']);
    } finally {
      await client.close();
    }
  });
});
