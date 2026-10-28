import { afterAll, beforeAll, expect, test } from 'bun:test';

import { loomMcpSession } from './testing/mcp';
import type { McpSession } from './testing/mcp';
import { pinsOf, quoted } from './testing/pins';
import { openBoard, stateChanges } from './testing/writes';
import type { OpenBoard, Tokens } from './testing/writes';

/**
 * MCP structured-content parity (ADR 0037): "equal capability and equal
 * structured content, not identical schemas". Each case calls Loom's generated
 * server and must answer its pin: the structured content, the first
 * `application/json` view. The pins were recorded while the old SDK server
 * answered the same calls over a twin board and were proven equal to its
 * content, parsed from its one JSON text part. A case name that names both
 * servers records how the call was respelled for Loom.
 *
 * Normalization: the Scratchpad UUID, random by design, reads `<uuid>`. The
 * cases run in order against one board, each write on it, so a later case reads
 * what an earlier one changed, and the board must end in the pinned state.
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

type Call = { tool: string; args: Record<string, unknown> };

/** One call to Loom's server. */
type McpCase = { name: string; loom: Call };

const same = (name: string, tool: string, args: Record<string, unknown> = {}): McpCase => ({
  loom: { args, tool },
  name,
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
  },
  // Writes: structure, fields, rank, tags, and the seed queue.
  {
    loom: {
      args: { desc: 'Made over MCP.', parent: 'MMR-2', title: 'New task' },
      tool: 'create_task',
    },
    name: 'create a task: create with a type on the old server, create_task on Loom',
  },
  {
    loom: { args: { parent: 'MMR-1', title: 'New phase' }, tool: 'create_phase' },
    name: 'create a phase: create_phase on Loom',
  },
  {
    loom: { args: { desc: 'Reworded.', id: 'MMR-3', priority: 'p1' }, tool: 'update' },
    name: 'update a task: description is desc',
  },
  same('update pins a project', 'update', { id: 'MMR', pinned: true }),
  same('update unpins a project with pinned false', 'update', { id: 'MMR', pinned: false }),
  {
    loom: { args: { id: 'MMR-10', top: true }, tool: 'reorder' },
    name: 'reorder: position top on the old server, top on Loom',
  },
  {
    loom: { args: { before: 'MMR-4', id: 'MMR-10' }, tool: 'reorder' },
    name: 'reorder: position before with ref, before with the sibling on Loom',
  },
  {
    loom: { args: { ids: 'MMR-3,MMR-4', tags: ['beta'] }, tool: 'tag' },
    name: 'tag: ids is one comma-separated string on Loom',
  },
  same('seeds', 'seeds', { project: 'MMR' }),
  {
    loom: { args: { id: 'MMR-s2', parent: 'MMR-2', title: 'From a seed' }, tool: 'promote' },
    name: 'promote a seed',
  },
  {
    loom: { args: { board: 'MMR', 'dry-run': true }, tool: 'triage' },
    name: 'triage: dryRun is dry-run',
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
  },
  {
    loom: {
      args: { action: 'complete', 'expected-updated-at': '{token}', id: '{pad}', words: ['1'] },
      tool: 'scratch_agenda',
    },
    name: 'scratch_agenda complete: number is a word',
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
  },
  {
    loom: {
      args: { 'expected-updated-at': '{token}', id: '{pad}', text: ['Checkpoint', 'text.'] },
      tool: 'scratch_checkpoint',
    },
    name: 'scratch_checkpoint: content on the old server, text words on Loom',
  },
  {
    loom: {
      args: { content: '# Notes\n\nInline body.', id: 'MMR-3', summary: 'inline', title: 'Inline' },
      tool: 'attach',
    },
    name: 'attach with an inline body: node on the old server, id on Loom',
  },
];

const FINAL_STATE =
  'the board ends holding the records the cases changed, including every record the answers name';
const pins = pinsOf(import.meta.url);
const keys = new Map(CASES.map((c) => [c, pins.claim(c.name)]));
const finalKey = pins.claim(FINAL_STATE);

let open: OpenBoard;
let tokens: Record<string, string>;
let loomServer: McpSession;

beforeAll(async () => {
  open = await openBoard();
  tokens = { ...open.tokens };
  loomServer = loomMcpSession(open.board.app('MMR'));
});

afterAll(async () => {
  await loomServer.close();
  await open.close();
});

/** The answers the server gave, whose ids the final state reads back from the board. */
const answers: string[] = [];

/** A Scratchpad receipt carries the next concurrency token; later cases on that pad use it. */
function advanceToken(structured: unknown): void {
  const receipt = structured as { id?: unknown; updated_at?: unknown };
  if (receipt.id === tokens.pad && typeof receipt.updated_at === 'string') {
    tokens.token = receipt.updated_at;
  }
}

test.each(CASES)('$name answers its pinned structured content', async (c) => {
  const answer = await loomServer.call(c.loom.tool, filledArgs(c.loom.args, tokens));
  expect(answer.isError, answer.text).toBe(false);
  expect(answer.structured).toBeDefined();
  advanceToken(answer.structured);
  answers.push(answer.text);
  pins.check(keys.get(c)!, quoted(`${named(answer.structured)}\n`));
});

test(FINAL_STATE, async () => {
  const texts = ['MMR-3', 'MMR-8', ...answers];
  pins.check(finalKey, `--- state\n${await stateChanges(open.board, tokens, texts)}`);
});

test('a refusal is a failed call whose structured content is the failure form', async () => {
  const answer = await loomServer.call('get', { id: 'MMR-999' });
  expect(answer.isError).toBe(true);
  expect(answer.structured).toMatchObject({
    exitCode: 1,
    failure: { code: 'not-found', exitCode: 1 },
  });
});
