import { afterAll, beforeAll, expect, test } from 'bun:test';

import { loomMcpSession } from './testing/mcp';
import type { McpSession } from './testing/mcp';
import { pinsOf, quoted } from './testing/pins';
import { boardTemplate, openCopy, stateChanges } from './testing/writes';
import type { BoardTemplate, OpenBoard, Tokens } from './testing/writes';

/**
 * The MCP tools' own surface (ADR 0037). A tool's structured content is its
 * command's `application/json` view, which the command's `-f json` CLI pin
 * owns, so these cases prove what only MCP does: the argument spellings a
 * tool call takes (a filter as a list, ids as one comma-separated string,
 * `pinned: false`, free text as a list of words, an inline body) reach the
 * command, and the answer is a successful call that carries structured
 * content. A case asserts the fields that show its arguments arrived. A view
 * no `-f json` CLI pin owns has its whole structured content pinned by at
 * least one case. Every tool's input names and types are pinned too: no CLI
 * pin sees an input that only MCP names or drops, such as a positional's
 * declared name or an option under `mcpInput({ exclude: true })`.
 *
 * Normalization: the Scratchpad UUID, random by design, reads `<uuid>`. The
 * cases run in order against one board, each write on it, so a later case reads
 * what an earlier one changed, and the board must end in the pinned state.
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** One tool call, the fields its answer must hold, and whether its whole answer is pinned. */
type McpCase = {
  name: string;
  tool: string;
  args: Record<string, unknown>;
  holds: Record<string, unknown>;
  pinned: boolean;
};

/** A call whose command's `-f json` CLI pin owns the rest of its answer. */
const holding = (
  name: string,
  tool: string,
  args: Record<string, unknown>,
  holds: Record<string, unknown>,
): McpCase => ({ args, holds, name, pinned: false, tool });

/** A call whose command has no `-f json` CLI pin for this view, so its whole answer is pinned. */
const pinned = (
  name: string,
  tool: string,
  args: Record<string, unknown>,
  holds: Record<string, unknown>,
): McpCase => ({ args, holds, name, pinned: true, tool });

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

/** The rows a list answer names, by id. */
const rows = (...ids: string[]) => ({ tasks: ids.map((id) => ({ id })), total: ids.length });

/** The receipt a Scratchpad write answers, by its open agenda count. */
const padReceipt = (openAgenda: number) => ({ open_agenda: openAgenda, project: 'MMR' });

const CASES: readonly McpCase[] = [
  // Every record was created at 2026-10-01T12:00Z. On Kiritimati (UTC+14), 2 October begins
  // at 2026-10-01T10:00Z, so the bound admits every row in that zone and none in UTC. MMR-3
  // blocks MMR-4, so `not-is: blocking` leaves it out.
  holding(
    'list takes kebab-case filters as lists, and a tz',
    'list',
    {
      'at-or-after': ['created_at:2026-10-02'],
      'not-is': ['blocking'],
      scope: 'MMR',
      tz: 'Pacific/Kiritimati',
    },
    rows('MMR-4', 'MMR-5', 'MMR-8', 'MMR-6'),
  ),
  holding(
    'list drops the rows a kebab-case date bound excludes',
    'list',
    { 'at-or-after': ['created_at:2026-10-02'], scope: 'MMR', tz: 'UTC' },
    rows(),
  ),
  // MMR-3 is the p1 task, so `not-eq: priority:p1` leaves only the other ready task.
  holding(
    'next takes kebab-case filters as lists',
    'next',
    {
      'at-or-before': ['created_at:2026-10-01T12:00:00Z'],
      'not-eq': ['priority:p1'],
      scope: 'MMR',
    },
    rows('MMR-8'),
  ),
  holding(
    'next drops the tasks a kebab-case date bound excludes',
    'next',
    { 'at-or-before': ['created_at:2026-10-01T11:59:59Z'], scope: 'MMR' },
    rows(),
  ),
  // `done` and `create phase` have no `-f json` CLI pin for a successful write.
  pinned('done', 'done', { id: 'MMR-8' }, { id: 'MMR-8', lifecycle: 'done' }),
  pinned(
    'create_phase',
    'create_phase',
    { parent: 'MMR-1', title: 'New phase' },
    { parent: 'MMR-1', type: 'phase' },
  ),
  // The CLI pins `update -f json` on a task, a seed, and an artifact, not a project. The next
  // case pins the project view whole, so this one holds only the field it set.
  holding('update pins a project', 'update', { id: 'MMR', pinned: true }, { pinned: true }),
  pinned(
    'update unpins a project with pinned false',
    'update',
    { id: 'MMR', pinned: false },
    { id: 'MMR', pinned: false },
  ),
  // `reorder` has no `-f json` CLI pin. Its answer carries no rank, so the final state shows
  // that MMR-4 moved to the top and then MMR-5 above it.
  pinned('reorder takes top', 'reorder', { id: 'MMR-4', top: true }, { id: 'MMR-4' }),
  pinned('reorder takes before as the sibling id', 'reorder', { before: 'MMR-4', id: 'MMR-5' }, {}),
  holding(
    'tag takes ids as one comma-separated string',
    'tag',
    { ids: 'MMR-3,MMR-4', tags: ['beta'] },
    { tagged: { ids: ['MMR-3', 'MMR-4'], tags: ['beta'] } },
  ),
  // `scratch agenda` and `scratch checkpoint` have no `-f json` CLI pin.
  pinned(
    'scratch_agenda add takes the item as words',
    'scratch_agenda',
    { action: 'add', 'expected-updated-at': '{token}', id: '{pad}', words: ['A', 'new', 'item'] },
    padReceipt(3),
  ),
  pinned(
    'scratch_agenda complete takes the number as a word',
    'scratch_agenda',
    { action: 'complete', 'expected-updated-at': '{token}', id: '{pad}', words: ['1'] },
    padReceipt(2),
  ),
  pinned(
    'scratch_agenda supersede takes the number as a word and keeps the reason',
    'scratch_agenda',
    {
      action: 'supersede',
      'expected-updated-at': '{token}',
      id: '{pad}',
      reason: 'folded',
      words: ['2'],
    },
    padReceipt(1),
  ),
  pinned(
    'scratch_checkpoint takes the text as words',
    'scratch_checkpoint',
    { 'expected-updated-at': '{token}', id: '{pad}', text: ['Checkpoint', 'text.'] },
    padReceipt(1),
  ),
  holding(
    'attach takes an inline body',
    'attach',
    { content: '# Notes\n\nInline body.', id: 'MMR-3', summary: 'inline', title: 'Inline' },
    { artifact: { id: 'MMR-a2' } },
  ),
];

const FINAL_STATE =
  'the board ends holding the records the cases changed, including every record the answers name';
const INPUTS = 'every tool takes its inputs under these names and types';
const pins = pinsOf(import.meta.url);
const keys = new Map(CASES.filter((c) => c.pinned).map((c) => [c, pins.claim(c.name)]));
const finalKey = pins.claim(FINAL_STATE);
const inputsKey = pins.claim(INPUTS);

let template: BoardTemplate;
let open: OpenBoard;
let tokens: Record<string, string>;
let loomServer: McpSession;

beforeAll(async () => {
  template = await boardTemplate();
  open = await openCopy(template);
  tokens = { ...open.tokens };
  loomServer = loomMcpSession(open.board.app('MMR'));
});

afterAll(async () => {
  await loomServer.close();
  await open.close();
});

/** A Scratchpad receipt carries the next concurrency token; later cases on that pad use it. */
function advanceToken(structured: unknown): void {
  const receipt = structured as { id?: unknown; updated_at?: unknown };
  if (receipt.id === tokens.pad && typeof receipt.updated_at === 'string') {
    tokens.token = receipt.updated_at;
  }
}

test.each(CASES)('$name answers structured content that shows its arguments arrived', async (c) => {
  const answer = await loomServer.call(c.tool, filledArgs(c.args, tokens));
  expect(answer.isError, answer.text).toBe(false);
  expect(answer.structured).toMatchObject(c.holds);
  advanceToken(answer.structured);
  const key = keys.get(c);
  if (key !== undefined) {
    pins.check(key, quoted(`${named(answer.structured)}\n`));
  }
});

test(FINAL_STATE, async () => {
  pins.check(finalKey, `--- state\n${await stateChanges(open.board, tokens, template)}`);
});

test(INPUTS, async () => {
  const lines: string[] = [];
  for (const tool of (await loomServer.tools()).toSorted()) {
    const { properties } = await loomServer.schema(tool);
    const inputs = Object.entries(properties)
      .map(([name, schema]) => `${name}: ${schema.type ?? 'any'}`)
      .toSorted();
    lines.push(`${tool}(${inputs.join(', ')})`);
  }
  pins.check(inputsKey, quoted(`${lines.join('\n')}\n`));
});

test('a refusal is a failed call whose structured content is the failure form', async () => {
  const answer = await loomServer.call('get', { id: 'MMR-999' });
  expect(answer.isError).toBe(true);
  expect(answer.structured).toMatchObject({
    exitCode: 1,
    failure: { code: 'not-found', exitCode: 1 },
  });
});
