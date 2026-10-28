import { afterAll, beforeAll, expect, test } from 'bun:test';

import { loomMcpSession, oldMcpSession } from './testing/mcp';
import type { McpSession } from './testing/mcp';
import { boardSnapshot } from './testing/snapshot';
import { openTwin } from './testing/twin';
import type { Tokens, Twin } from './testing/twin';

/**
 * MCP structured-content parity (ADR 0037): "equal capability and equal
 * structured content, not identical schemas". The old SDK server and Loom's
 * generated server answer the same call over twin boards built the same way
 * under one frozen clock, and the structured content must be equal. The old
 * server's content is its one JSON text part, parsed; Loom's is
 * `structuredContent`, the first `application/json` view.
 *
 * Normalizations: the Scratchpad UUID, random by design, which reads
 * `<uuid>` on both sides. The cases run in order against one twin, each write
 * on both boards, so a later case reads what an earlier one changed, and the
 * boards must end holding the same records.
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

type Call = { tool: string; args: Record<string, unknown> };

/** One call spelled for each server: the old tool and its arguments, and Loom's. */
type McpCase = { name: string; old: Call; loom: Call };

/** A case whose two spellings differ only by the tool and argument names. */
const same = (name: string, tool: string, args: Record<string, unknown> = {}): McpCase => ({
  loom: { args, tool },
  name,
  old: { args, tool },
});

/** `{token}` placeholders in a string argument, filled with the board's value. */
function filled(value: unknown, tokens: Tokens): unknown {
  if (typeof value === 'string') {
    return value.replaceAll(/\{(\w+)\}/g, (whole, name: string) => tokens[name] ?? whole);
  }
  if (Array.isArray(value)) {
    return value.map((one) => filled(one, tokens));
  }
  return value;
}

const filledArgs = (args: Record<string, unknown>, tokens: Tokens): Record<string, unknown> =>
  Object.fromEntries(Object.entries(args).map(([key, value]) => [key, filled(value, tokens)]));

const named = (value: unknown): string => JSON.stringify(value, null, 2).replaceAll(UUID, '<uuid>');

const CASES: readonly McpCase[] = [
  same('next, scoped', 'next', { scope: 'MMR' }),
  same('next, from the clone binding', 'next'),
  same('get a task', 'get', { id: 'MMR-3' }),
  {
    loom: { args: { id: 'MMR-s2' }, tool: 'get' },
    name: 'get a seed: get_seed on the old server, get on Loom',
    old: { args: { id: 'MMR-s2' }, tool: 'get_seed' },
  },
  same('overview', 'overview', { scope: 'MMR' }),
  same('list', 'list', { scope: 'MMR', status: 'all' }),
  same('search', 'search', { query: 'store', scope: 'MMR' }),
  same('status', 'status', { id: 'MMR-3' }),
  same('projects', 'projects'),
  same('scratch_list', 'scratch_list'),
  same('scratch_get', 'scratch_get', { id: '{pad}' }),
  // A lifecycle verb: start, then done, the task in rank order's last.
  same('start', 'start', { id: 'MMR-8' }),
  same('done', 'done', { id: 'MMR-8' }),
  {
    loom: { args: { id: 'MMR-3', text: 'From the parity run.' }, tool: 'annotate' },
    name: 'annotate: content on the old server, text on Loom',
    old: { args: { content: 'From the parity run.', id: 'MMR-3' }, tool: 'annotate' },
  },
  // Writes: structure, fields, rank, tags, and the seed queue.
  {
    loom: {
      args: { desc: 'Made over MCP.', parent: 'MMR-2', title: 'New task' },
      tool: 'create_task',
    },
    name: 'create a task: create with a type on the old server, create_task on Loom',
    old: {
      args: { description: 'Made over MCP.', parent: 'MMR-2', title: 'New task', type: 'task' },
      tool: 'create',
    },
  },
  {
    loom: { args: { parent: 'MMR-1', title: 'New phase' }, tool: 'create_phase' },
    name: 'create a phase: create_phase on Loom',
    old: { args: { parent: 'MMR-1', title: 'New phase', type: 'phase' }, tool: 'create' },
  },
  {
    loom: { args: { desc: 'Reworded.', id: 'MMR-3', priority: 'p1' }, tool: 'update' },
    name: 'update a task: description is desc',
    old: { args: { description: 'Reworded.', id: 'MMR-3', priority: 'p1' }, tool: 'update' },
  },
  same('update pins a project', 'update', { id: 'MMR', pinned: true }),
  same('update unpins a project with pinned false', 'update', { id: 'MMR', pinned: false }),
  {
    loom: { args: { id: 'MMR-10', top: true }, tool: 'reorder' },
    name: 'reorder: position top on the old server, top on Loom',
    old: { args: { id: 'MMR-10', position: 'top' }, tool: 'reorder' },
  },
  {
    loom: { args: { before: 'MMR-4', id: 'MMR-10' }, tool: 'reorder' },
    name: 'reorder: position before with ref, before with the sibling on Loom',
    old: { args: { id: 'MMR-10', position: 'before', ref: 'MMR-4' }, tool: 'reorder' },
  },
  {
    loom: { args: { ids: 'MMR-3,MMR-4', tags: ['beta'] }, tool: 'tag' },
    name: 'tag: ids is one comma-separated string on Loom',
    old: { args: { ids: ['MMR-3', 'MMR-4'], tags: ['beta'] }, tool: 'tag' },
  },
  same('seeds', 'seeds', { project: 'MMR' }),
  {
    loom: { args: { id: 'MMR-s2', parent: 'MMR-2', title: 'From a seed' }, tool: 'promote' },
    name: 'promote a seed',
    old: { args: { id: 'MMR-s2', parent: 'MMR-2', title: 'From a seed' }, tool: 'promote' },
  },
  {
    loom: { args: { board: 'MMR', 'dry-run': true }, tool: 'triage' },
    name: 'triage: dryRun is dry-run',
    old: { args: { board: 'MMR', dryRun: true }, tool: 'triage' },
  },
  {
    loom: {
      args: {
        'at-or-after': ['created_at:2026-01-01'],
        'not-is': ['stale'],
        scope: 'MMR',
        tz: 'UTC',
      },
      tool: 'list',
    },
    name: 'list with kebab-case filters and a tz',
    old: {
      args: { atOrAfter: ['created_at:2026-01-01'], notIs: ['stale'], scope: 'MMR', tz: 'UTC' },
      tool: 'list',
    },
  },
  {
    loom: {
      args: {
        'at-or-before': ['created_at:2026-12-31T00:00:00Z'],
        'not-eq': ['priority:p3'],
        scope: 'MMR',
      },
      tool: 'next',
    },
    name: 'next with kebab-case filters',
    old: {
      args: {
        atOrBefore: ['created_at:2026-12-31T00:00:00Z'],
        notEq: ['priority:p3'],
        scope: 'MMR',
      },
      tool: 'next',
    },
  },
  {
    loom: {
      args: {
        action: 'add',
        'expected-updated-at': '{token}',
        id: '{pad}',
        words: ['A', 'new', 'item'],
      },
      tool: 'scratch_agenda',
    },
    name: 'scratch_agenda add: content is words',
    old: {
      args: { content: 'A new item', expected_updated_at: '{token}', id: '{pad}' },
      tool: 'scratch_agenda_add',
    },
  },
  {
    loom: {
      args: { action: 'complete', 'expected-updated-at': '{token}', id: '{pad}', words: ['1'] },
      tool: 'scratch_agenda',
    },
    name: 'scratch_agenda complete: number is a word',
    old: {
      args: { expected_updated_at: '{token}', id: '{pad}', number: 1 },
      tool: 'scratch_agenda_complete',
    },
  },
  {
    loom: {
      args: {
        action: 'supersede',
        'expected-updated-at': '{token}',
        id: '{pad}',
        reason: 'folded',
        words: ['2'],
      },
      tool: 'scratch_agenda',
    },
    name: 'scratch_agenda supersede: number is a word, reason stays',
    old: {
      args: { expected_updated_at: '{token}', id: '{pad}', number: 2, reason: 'folded' },
      tool: 'scratch_agenda_supersede',
    },
  },
  {
    loom: {
      args: { 'expected-updated-at': '{token}', id: '{pad}', text: ['Checkpoint', 'text.'] },
      tool: 'scratch_checkpoint',
    },
    name: 'scratch_checkpoint: content on the old server, text words on Loom',
    old: {
      args: { content: 'Checkpoint text.', expected_updated_at: '{token}', id: '{pad}' },
      tool: 'scratch_checkpoint',
    },
  },
  {
    loom: {
      args: { content: '# Notes\n\nInline body.', id: 'MMR-3', summary: 'inline', title: 'Inline' },
      tool: 'attach',
    },
    name: 'attach with an inline body: node on the old server, id on Loom',
    old: {
      args: {
        content: '# Notes\n\nInline body.',
        node: 'MMR-3',
        summary: 'inline',
        title: 'Inline',
      },
      tool: 'attach',
    },
  },
];

let twin: Twin;
let oldTokens: Record<string, string>;
let nextTokens: Record<string, string>;
let oldServer: McpSession;
let loomServer: McpSession;

beforeAll(async () => {
  twin = await openTwin();
  oldTokens = { ...twin.old.tokens };
  nextTokens = { ...twin.next.tokens };
  oldServer = await oldMcpSession(twin.old.board.store, 'MMR');
  loomServer = loomMcpSession(twin.next.board.app('MMR'));
});

afterAll(async () => {
  await oldServer.close();
  await loomServer.close();
  await twin.close();
});

/** The answers each server gave, whose ids the final snapshot reads back from each board. */
const answers: { old: string[]; next: string[] } = { next: [], old: [] };

/** A Scratchpad receipt carries the next concurrency token; later cases on that pad use it. */
function advanceToken(tokens: Record<string, string>, structured: unknown): void {
  const receipt = structured as { id?: unknown; updated_at?: unknown };
  if (receipt.id === tokens.pad && typeof receipt.updated_at === 'string') {
    tokens.token = receipt.updated_at;
  }
}

test.each(CASES)('$name has equal structured content', async (c) => {
  const old = await oldServer.call(c.old.tool, filledArgs(c.old.args, oldTokens));
  const next = await loomServer.call(c.loom.tool, filledArgs(c.loom.args, nextTokens));
  expect(old.isError, old.text).toBe(false);
  expect(next.isError, next.text).toBe(false);
  expect(next.structured).toBeDefined();
  expect(named(next.structured)).toBe(named(old.structured));
  advanceToken(oldTokens, old.structured);
  advanceToken(nextTokens, next.structured);
  answers.old.push(old.text);
  answers.next.push(next.text);
});

test('the boards end holding the same records, including every record the answers name', async () => {
  const [before, after] = await Promise.all([
    boardSnapshot(twin.old.board, oldTokens, ['MMR-3', 'MMR-8', ...answers.old]),
    boardSnapshot(twin.next.board, nextTokens, ['MMR-3', 'MMR-8', ...answers.next]),
  ]);
  expect(after).toBe(before);
});

test('a refusal is a failed call whose structured content is the failure form', async () => {
  const next = await loomServer.call('get', { id: 'MMR-999' });
  expect(next.isError).toBe(true);
  expect(next.structured).toMatchObject({
    exitCode: 1,
    failure: { code: 'not-found', exitCode: 1 },
  });
});
