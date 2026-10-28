/**
 * The MCP capability map (ADR 0037): every tool the old MCP server in
 * `packages/bin` registers, and the Loom tool that covers it. Loom names a
 * tool by its command path joined with `_`, and an input by its declared
 * option or argument name, so a covered tool may keep its capability and
 * change its spelling. The test fails when the old server gains a tool the
 * map lacks, when a named Loom tool does not exist, or when a Loom tool is in
 * neither the map nor `ADDED`. Test-only data, read by `mcp-capabilities.test.ts`.
 */

/** An old tool, the Loom tools that cover it, and what changed for a caller. */
export type ToolCoverage = {
  loom: readonly string[];
  /** What an agent must now spell differently; absent when the call is the same. */
  change?: string;
  /**
   * Each old input that is renamed, retyped, or dropped: its old key, and the
   * Loom key that takes it (the same key when only its type changed), or
   * `null` when no input takes it. The test diffs the two servers' schemas
   * and fails when a changed input is missing here.
   */
  inputs?: Readonly<Record<string, string | null>>;
};

/** Camel and snake case inputs are kebab case on Loom's tools. */
const KEBAB = 'inputs are named as the command declares them, in kebab case';

/** A date given without a time and without `tz` was refused; it now reads in the server's zone. */
const SERVER_ZONE =
  "a calendar date without `tz` reads in the server's time zone, where the old tool refused it";

const RETIRED_ALL = '`scope: "all"` is retired';

/** A free-text reason is the words after the argument, so it is advertised as a list; a string works. */
const REASON = { reason: 'reason' } as const;
const REASON_CHANGE = '`reason` is advertised as a list of words; one string works';

/** `limit` and `offset` are advertised as strings; a number works. */
const COUNTS = { limit: 'limit' } as const;

const DATES = { atOrAfter: 'at-or-after', atOrBefore: 'at-or-before' } as const;

const FILTERS = {
  ...DATES,
  ...COUNTS,
  notEq: 'not-eq',
  notIn: 'not-in',
  notIs: 'not-is',
  q: 'query',
} as const;

const GUARD = '`expected_updated_at` is `expected-updated-at`';
const GUARD_INPUT = { expected_updated_at: 'expected-updated-at' } as const;

const IDS_CHANGE = '`ids` is one comma-separated string, no longer a list';

export const TOOL_COVERAGE: Readonly<Record<string, ToolCoverage>> = {
  abandon: { change: REASON_CHANGE, inputs: REASON, loom: ['abandon'] },
  annotate: { change: '`content` is `text`', inputs: { content: 'text' }, loom: ['annotate'] },
  archive: { change: REASON_CHANGE, inputs: REASON, loom: ['archive'] },
  artifacts: {
    change: `${KEBAB}; \`q\` is \`query\`; ${RETIRED_ALL}; ${SERVER_ZONE}; \`limit\` and \`offset\` are advertised as strings, and a number works`,
    inputs: { ...DATES, limit: 'limit', offset: 'offset', q: 'query' },
    loom: ['artifacts'],
  },
  attach: {
    change:
      '`node` is `id`; `links` is `link`; `tags` is `tag`; `content` stays inline and a blank or whitespace-only body is refused; there is no `file` input over MCP',
    inputs: { links: 'link', node: 'id', tags: 'tag' },
    loom: ['attach'],
  },
  block: { change: REASON_CHANGE, inputs: REASON, loom: ['block'] },
  create: {
    change:
      'one tool per `type`: create_project, create_initiative, create_phase, create_task; `description` is `desc`, `externalRef` is `ref`, `openEnded` is `open-ended`, `tags` is `tag`; create_project needs `yes: true` and takes the name as `name`',
    inputs: {
      description: 'desc',
      externalRef: 'ref',
      openEnded: 'open-ended',
      tags: 'tag',
      type: null,
    },
    loom: ['create_project', 'create_initiative', 'create_phase', 'create_task'],
  },
  depend: {
    change: '`on` is one comma-separated string, no longer a list',
    inputs: { on: 'on' },
    loom: ['depend'],
  },
  done: { loom: ['done'] },
  get: { change: '`facets` is `col`', inputs: { facets: 'col' }, loom: ['get'] },
  get_seed: {
    change:
      'a seed is read by `get` with its KEY-sN id; the description is always included, so the `content: false` opt-out is gone',
    inputs: { content: null },
    loom: ['get'],
  },
  groom: {
    change: `${IDS_CHANGE}; \`note\` is advertised as a list of words, and one string works`,
    inputs: { ids: 'ids', note: 'note' },
    loom: ['groom'],
  },
  list: {
    change: `${KEBAB}; \`q\` is \`query\`; ${RETIRED_ALL}; ${SERVER_ZONE}; \`limit\` is advertised as a string, and a number works`,
    inputs: FILTERS,
    loom: ['list'],
  },
  move: { loom: ['move'] },
  next: {
    change: `${KEBAB}; \`q\` is \`query\`; ${RETIRED_ALL}; ${SERVER_ZONE}; \`limit\` is advertised as a string, and a number works`,
    inputs: FILTERS,
    loom: ['next'],
  },
  overview: { loom: ['overview'] },
  park: { change: REASON_CHANGE, inputs: REASON, loom: ['park'] },
  projects: { loom: ['projects'] },
  promote: {
    change: '`description` is `desc`; `tags` is `tag`',
    inputs: { description: 'desc', tags: 'tag' },
    loom: ['promote'],
  },
  queue: { loom: ['queue'] },
  reject: { change: REASON_CHANGE, inputs: REASON, loom: ['reject'] },
  reopen: { change: REASON_CHANGE, inputs: REASON, loom: ['reopen'] },
  reorder: {
    change:
      '`position` and `ref` are the options `top`, `bottom`, `before`, and `after`; before and after take the sibling as their value',
    inputs: { position: null, ref: null },
    loom: ['reorder'],
  },
  resolve: { change: REASON_CHANGE, inputs: REASON, loom: ['resolve'] },
  return: { change: REASON_CHANGE, inputs: REASON, loom: ['return'] },
  scratch_agenda_add: {
    change: '`scratch_agenda` with `action: "add"`, the item as `words`; no `number`',
    inputs: { ...GUARD_INPUT, content: 'words' },
    loom: ['scratch_agenda'],
  },
  scratch_agenda_complete: {
    change: '`scratch_agenda` with `action: "complete"`, the number as the one word in `words`',
    inputs: { ...GUARD_INPUT, number: 'words' },
    loom: ['scratch_agenda'],
  },
  scratch_agenda_supersede: {
    change:
      '`scratch_agenda` with `action: "supersede"`, the number in `words` and the reason as `reason`',
    inputs: { ...GUARD_INPUT, number: 'words' },
    loom: ['scratch_agenda'],
  },
  scratch_checkpoint: {
    change: `\`content\` is \`text\`, advertised as a list of words (one string works); ${GUARD}; there is no \`file\` input over MCP`,
    inputs: { ...GUARD_INPUT, content: 'text' },
    loom: ['scratch_checkpoint'],
  },
  scratch_create: {
    change: '`linked_work` is `link`; the title is `title` or the words in `words`',
    inputs: { linked_work: 'link' },
    loom: ['scratch_create'],
  },
  scratch_discard: { change: GUARD, inputs: GUARD_INPUT, loom: ['scratch_discard'] },
  scratch_freeze: {
    change: `${GUARD}; \`tags\` is \`tag\``,
    inputs: { ...GUARD_INPUT, tags: 'tag' },
    loom: ['scratch_freeze'],
  },
  scratch_get: { loom: ['scratch_get'] },
  scratch_list: { change: RETIRED_ALL, loom: ['scratch_list'] },
  scratch_update: {
    change: `${GUARD}; \`linked_work\` is \`link\`, and \`clear-links\` clears them`,
    inputs: { ...GUARD_INPUT, linked_work: 'link' },
    loom: ['scratch_update'],
  },
  search: {
    change: `${RETIRED_ALL}; \`query\` is advertised as a list of words (one string works); \`limit\` is advertised as a string, and a number works`,
    inputs: { limit: 'limit', query: 'query' },
    loom: ['search'],
  },
  seed: { change: '`description` is `desc`', inputs: { description: 'desc' }, loom: ['seed'] },
  seeds: {
    change: `${KEBAB}; \`project: "all"\` is retired; ${SERVER_ZONE}; \`project\` and \`scope\` both name the board`,
    inputs: DATES,
    loom: ['seeds'],
  },
  start: {
    change: '`workerHarness` and `workerSession` are `worker-harness` and `worker-session`',
    inputs: { workerHarness: 'worker-harness', workerSession: 'worker-session' },
    loom: ['start'],
  },
  status: { loom: ['status'] },
  submit: { loom: ['submit'] },
  tag: { change: IDS_CHANGE, inputs: { ids: 'ids' }, loom: ['tag'] },
  triage: {
    change: '`dryRun` is `dry-run`; `board` is as before',
    inputs: { dryRun: 'dry-run' },
    loom: ['triage'],
  },
  unarchive: { loom: ['unarchive'] },
  unblock: { loom: ['unblock'] },
  undepend: {
    change: '`on` is one comma-separated string, no longer a list',
    inputs: { on: 'on' },
    loom: ['undepend'],
  },
  unpark: { loom: ['unpark'] },
  unqueue: { change: REASON_CHANGE, inputs: REASON, loom: ['unqueue'] },
  untag: { change: IDS_CHANGE, inputs: { ids: 'ids' }, loom: ['untag'] },
  update: {
    change: `${KEBAB}; \`description\` is \`desc\`, \`externalRef\` is \`ref\`, \`next\` is \`direction\`, \`openEnded\` is \`open-ended\` with \`not-open-ended\` to clear; \`pinned: false\` unpins, as does \`not-pinned: true\``,
    inputs: {
      description: 'desc',
      externalRef: 'ref',
      next: 'direction',
      openEnded: 'open-ended',
      workerHarness: 'worker-harness',
      workerSession: 'worker-session',
    },
    loom: ['update'],
  },
};

/** Loom tools the old server had no counterpart for. */
export const ADDED: readonly string[] = ['tree'];

/** Old behavior with no Loom tool, and why none carries it. */
export const NOT_CARRIED: readonly { what: string; reason: string }[] = [
  {
    reason:
      'an Engine reads one board at a time (ADR 0034), and ADR 0037 retires `-s all`; an unbound call without `scope` is refused with a usage error that says to pass `-s KEY` (an MCP caller sends it as `scope`) or to bind the clone',
    what: 'scope "all" (and project "all" on seeds): the cross-project read',
  },
  {
    reason:
      'Loom projects a command declaration, and a declaration has one input spelling; the old camelCase and snake_case spellings are not accepted beside the kebab-case ones',
    what: 'camelCase and snake_case input names (`notIs`, `atOrBefore`, `workerSession`, `expected_updated_at`, `linked_work`)',
  },
  {
    reason:
      'the old server wrapped every failure as `{"error":{"code","message","hint"}}` in text; Loom returns the failure form `{exitCode, failure:{code, exitCode, message, hints}}` as structured content (ADR 0037)',
    what: 'the old error envelope',
  },
];
