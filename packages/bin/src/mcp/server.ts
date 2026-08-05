import {
  HOLD_VALUES,
  isTerminalLifecycle,
  LIFECYCLE_VALUES,
  PRIORITY_VALUES,
  SEED_KIND_VALUES,
  SEED_STATUS_SELECTOR_VALUES,
  SIZE_VALUES,
  STATUS_SELECTOR_VALUES,
  VERDICT_VALUES,
} from '@mimir/contract';
import type { FacetName, FieldKindName, OpFact } from '@mimir/contract';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ZodRawShape } from 'zod';

import { OP_SPECS, specUpdateFields, SPEC_UPDATE_FIELDS } from '../core';
import type { SpecUpdateField, Store } from '../core';
import {
  toolAnnotate,
  toolAttach,
  toolCreate,
  toolDepend,
  toolGet,
  toolList,
  toolMove,
  toolGetSeed,
  toolNext,
  toolArtifacts,
  toolOverview,
  toolPromote,
  toolReject,
  toolReorder,
  toolResolve,
  toolSeed,
  toolSeeds,
  toolStatus,
  toolTag,
  toolTriage,
  toolUndepend,
  toolUniform,
  toolUntag,
  toolUpdate,
  toolErrorResult,
  toolScratchAgendaAdd,
  toolScratchAgendaComplete,
  toolScratchAgendaSupersede,
  toolScratchCheckpoint,
  toolScratchCreate,
  toolScratchDiscard,
  toolScratchFreeze,
  toolScratchGet,
  toolScratchList,
  toolScratchUpdate,
} from './tools';
import type {
  ArtifactQueryToolArgs,
  SeedQueryToolArgs,
  SetQueryArgs,
  ToolResult,
  UniformToolArgs,
} from './tools';

/**
 * The MCP server — the agent envelope. Registers read + write tools over the
 * shared intent layer and speaks JSON-RPC over stdio via the official SDK.
 * Results are the structured `json` wire contract; errors use the structured
 * envelope `{"error":{"code","message","hint?"}}`.
 */

const PRIORITY = z.enum(PRIORITY_VALUES);
const SIZE = z.enum(SIZE_VALUES);
const STATUS = z.enum(STATUS_SELECTOR_VALUES);
const VERDICT = z.enum(VERDICT_VALUES);
const SEED_KIND = z.enum(SEED_KIND_VALUES);
const SEED_STATUS = z.enum(SEED_STATUS_SELECTOR_VALUES);
const SEED_SORT = z.enum(['asc', 'desc']);
const TOKENS = z.array(z.string());
/**
 * The date operators every date-bearing resource shares (ADR 0029) —
 * `FIELD:VALUE` tokens plus the caller's IANA timezone, which a query
 * containing a bare `YYYY-MM-DD` must carry: an MCP caller's calendar is not
 * the server's, and guessing one is how the two drift apart.
 */
const DATE_OPERATOR_SCHEMA = {
  after: TOKENS.optional(),
  atOrAfter: TOKENS.optional(),
  atOrBefore: TOKENS.optional(),
  before: TOKENS.optional(),
  on: TOKENS.optional(),
  tz: z.string().optional(),
};
// Field operators (MMR-33): FIELD:VALUE tokens (bare FIELD for has/missing).
const OPERATOR_SCHEMA = {
  ...DATE_OPERATOR_SCHEMA,
  eq: TOKENS.optional(),
  has: TOKENS.optional(),
  in: TOKENS.optional(),
  is: z.array(VERDICT).optional(),
  missing: TOKENS.optional(),
  notEq: TOKENS.optional(),
  notIn: TOKENS.optional(),
  notIs: z.array(VERDICT).optional(),
};
const FACET = z.enum([
  'deps',
  'annotations',
  'artifacts',
  'history',
  'tags',
  'children',
  'distribution',
  'content', // artifact-only: the frozen body (heavy, opt-in)
]);
const LIMIT = z.number().int().positive();

/**
 * The per-kind zod fragment — the MCP view of a field **kind** (ADR 0025). The
 * kind's parser/emitter and query bindings live in the core; its wire schema is
 * a transport template, and MCP is its only zod consumer, so the fragment lives
 * here rather than in the shared registry. Keyed by the full {@link FieldKindName}
 * union, so a new kind is a compile error here, not a silently untyped arg. Each
 * entry is the base type; {@link fieldInputShape} adds `.optional()`.
 */
const KIND_ZOD: Record<FieldKindName, z.ZodType> = {
  bool: z.boolean(),
  'enum:hold': z.enum(HOLD_VALUES),
  'enum:lifecycle': z.enum(LIFECYCLE_VALUES),
  'enum:priority': z.enum(PRIORITY_VALUES),
  'enum:size': z.enum(SIZE_VALUES),
  'seed-ref': z.string(),
  string: z.string(),
};

/**
 * The `update`/`create` arg fragment for the generic-`update` spec fields (ADR
 * 0025) — each named by its camelCase update key, typed by its kind, optional.
 * Both tool schemas compose this with their own bespoke identity/topology args
 * (`id`/`type`/`parent`/`title`/…). Parameterized for the derivation test.
 */
export function fieldInputShape(
  fields: readonly SpecUpdateField[] = SPEC_UPDATE_FIELDS,
): ZodRawShape {
  const shape: Record<string, ZodRawShape[string]> = {};
  for (const field of fields) {
    shape[field.update] = KIND_ZOD[field.kind].optional();
  }
  return shape;
}

/**
 * The MCP input schema for a uniform verb (ADR 0025) — the subject id arg (`id`
 * for a task, `key` for a project), an optional `reason` when the verb's policy
 * accepts one, and the extra data-plane fields the verb declares (ADR 0026 —
 * only `start`'s resume handles), typed by the SAME kind fragment the `update`
 * tool derives. Pure over the operation fact, so a new registry entry registers
 * its tool with no edit here; a verb declaring no extra fields advertises exactly
 * what it did before.
 */
export function uniformToolSchema(spec: OpFact): ZodRawShape {
  const subject: ZodRawShape =
    spec.subject === 'project' ? { key: z.string() } : { id: z.string() };
  const reason: ZodRawShape = spec.reason === 'optional' ? { reason: z.string().optional() } : {};
  return sortedShape({
    ...subject,
    ...reason,
    ...fieldInputShape(specUpdateFields(spec.fields ?? [])),
  });
}

/**
 * The MCP tool description for a uniform verb (ADR 0025 Decision 4) — a view
 * template composing the canonical summary (capitalized) with the transition
 * arrow, the reason clause, and the echo clause. No per-verb prose lives on the
 * registry; the previously hand-authored descriptions become this derived form
 * (disclosed as golden diffs, MMR-316).
 */
export function uniformToolDescription(spec: OpFact): string {
  const t = spec.transition;
  const arrow =
    t.axis === 'lifecycle' && !isTerminalLifecycle(t.to) ? ` (${t.from.join('/')} → ${t.to})` : '';
  const head = `${spec.summary.charAt(0).toUpperCase()}${spec.summary.slice(1)}`;
  const reason =
    spec.reason === 'optional' ? ' Optionally records a reason on the transition.' : '';
  const echo = spec.subject === 'project' ? 'Echoes the project.' : 'Echoes the updated node.';
  return `${head}${arrow}.${reason} ${echo}`;
}

/** Reorder a raw shape's keys alphabetically — the tool schemas keep their
 * hand-authored alphabetical arg order once the derived fields are merged in. */
function sortedShape(shape: ZodRawShape): ZodRawShape {
  const out: Record<string, ZodRawShape[string]> = {};
  for (const key of Object.keys(shape).toSorted()) {
    const value = shape[key];
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Register a tool from its `inputSchema` raw shape. The shape is wrapped in one
 * strict object here so runtime parsing rejects keys outside the advertised
 * JSON Schema; the widened SDK signature stops its per-field generic inference
 * from recursing past the type-checker's depth limit (TS2589). The handler
 * casts the validated args to its known shape.
 */
type RegisterFn = (
  name: string,
  config: { description: string; inputSchema: z.ZodType },
  cb: (args: unknown) => Promise<ToolResult>,
) => void;

// <A> is inferred from `handler` so each call site gets typed args; dropping it
// would push `unknown` casts to every registration. Deliberate API ergonomics.
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
function register<A>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: ZodRawShape,
  handler: (args: A) => Promise<ToolResult>,
): void {
  // Bind to a concrete, non-generic signature so the type-checker doesn't
  // instantiate registerTool's deep per-field generics (TS2589); `this` is
  // preserved by bind, and zod still validates at runtime. The MCP SDK's types
  // don't expose a usable narrow signature here, so the seam is cast (case 2).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const registerTool = server.registerTool.bind(server) as unknown as RegisterFn;
  // The SDK turns a raw shape into a default Zod object, whose runtime parser
  // strips unknown keys even though its generated JSON Schema advertises
  // `additionalProperties: false`. Build the object here instead so the one
  // registration seam gives every tool the same strict wire contract it
  // advertises. The SDK stores and dispatches through this exact schema.
  const schema = z.strictObject(inputSchema);
  // args is zod-validated at runtime; A is the caller's declared shape.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  registerTool(name, { description, inputSchema: schema }, (args) => handler(args as A));
}

const ARTICLE_VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);
const articleFor = (word: string): string => (ARTICLE_VOWELS.has(word[0] ?? '') ? 'an' : 'a');

/**
 * Synthesize a house-voice fault + hint from a tool-input schema miss
 * (output-voice.md, MMR-292). An undeclared argument wins over a missing
 * required argument because it is the caller-provided fault. Names the arg as the
 * subject where the issue allows (`id must be a string`, `'type' is required`),
 * states one fault, and points at the tool's advertised contract — the
 * narrowest hint rung that applies to an args fault. Reads the structured zod
 * issue only; no library wording is ever echoed.
 */
function schemaMissVoice(
  name: string,
  error: z.ZodError,
  args: Record<string, unknown>,
): { hint: string; message: string } {
  const hint = `check the arguments against the '${name}' tool schema`;
  const issue =
    error.issues.find((candidate) => candidate.code === 'unrecognized_keys') ?? error.issues[0];
  if (issue?.code === 'unrecognized_keys') {
    const key = issue.keys[0] ?? 'input';
    return { hint, message: `${key} isn't an argument` };
  }
  const field = issue === undefined ? 'input' : String(issue.path[0] ?? 'input');
  // Field-as-subject, unquoted, per the voice guide's token-as-subject rule
  // (matching respond.ts's `${key} must be a string`). A top-level arg that is
  // simply absent reads as "required"; a present but ill-typed / out-of-
  // vocabulary arg states the constraint on its value.
  if (issue !== undefined && issue.path.length <= 1 && args[field] === undefined) {
    return { hint, message: `${field} is required` };
  }
  if (issue?.code === 'invalid_type') {
    const expected = issue.expected;
    return { hint, message: `${field} must be ${articleFor(expected)} ${expected}` };
  }
  if (issue?.code === 'invalid_value' && issue.values.length > 0) {
    const values = issue.values.map((v) => `'${String(v)}'`).join(', ');
    return { hint, message: `${field} must be one of ${values}` };
  }
  if (issue?.code === 'too_small') {
    return { hint, message: `${field} must not be empty` };
  }
  return { hint, message: `${field} is not valid` };
}

/** Levenshtein edit distance — small inputs (tool names), one-row DP (mirrors
 * cli/run.ts's flag/command nearest-match; kept as this module's own copy
 * rather than a cross-domain import for a ~15-line algorithm). */
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j] ?? 0;
      row[j] = Math.min(above + 1, (row[j - 1] ?? 0) + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = above;
    }
  }
  return row[b.length] ?? 0;
}

/**
 * The closest registered tool name to `name`, but only when it's a genuinely
 * near miss: within 2 edits, strictly shorter distance than the input's own
 * length, and UNAMBIGUOUS — a tie at the minimum yields no suggestion rather
 * than an arbitrary one.
 */
function nearestTool(name: string, known: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestD = Number.POSITIVE_INFINITY;
  let tied = false;
  for (const candidate of known) {
    const d = editDistance(name, candidate);
    if (d < bestD) {
      bestD = d;
      best = candidate;
      tied = false;
    } else if (d === bestD) {
      tied = true;
    }
  }
  return best !== undefined && !tied && bestD <= 2 && bestD < name.length ? best : undefined;
}

/**
 * Synthesize a house-voice not-found fault + hint for a CallTool request
 * naming an unregistered tool (output-voice.md, MMR-296 — the not-found
 * sibling of MMR-292's schema-miss guard, same choke point). Token-as-subject
 * (`${name} doesn't exist`, matching core's `notFound` convention); the hint
 * ladder's near-match rung fires when an edit-distance candidate exists among
 * the registered tools, else the narrowest pointer at tools/list.
 */
function unknownToolVoice(name: string, known: string[]): { hint: string; message: string } {
  const suggestion = nearestTool(name, known);
  const hint =
    suggestion !== undefined
      ? `did you mean '${suggestion}'?`
      : "run 'tools/list' to see the available tools";
  // An empty name is never a near miss (nearestTool's own length guard rules
  // it out) but still needs a legible subject — quoted, per the voice guide's
  // literal-in-prose rule, rather than the blank `" doesn't exist"`.
  const subject = name === '' ? "''" : name;
  return { hint, message: `${subject} doesn't exist` };
}

/**
 * Re-voice the SDK's pre-handler input validation (MMR-292) and its
 * unregistered-tool-name fault (MMR-296). The MCP SDK zod-validates each
 * tool's `inputSchema` before the handler runs and, on a miss, ships the raw
 * zod aggregation as the tool-result text (`MCP error -32602: Invalid
 * arguments for tool … [<zod issues>]`); a CallTool naming a tool that was
 * never registered ships the SDK's own raw text the same way (`MCP error
 * -32602: Tool <name> not found`). output-voice.md forbids library text in any
 * envelope, so this one choke point re-validates with the SDK's OWN stored
 * schema and, on either miss, returns the same structured
 * `{"error":{code,message,hint}}` envelope every other tool fault uses. On a
 * schema pass it writes the coalesced arguments back onto the request before
 * dispatching, so the SDK's own validation — which still runs — sees the
 * identical value the guard just accepted and therefore cannot fail (an omitted
 * `arguments` key would otherwise reach the SDK as `undefined` and re-leak for
 * all-optional tools). The guard does not rewrite the advertised tools/list
 * schema.
 *
 * The SDK exposes no public accessor for its registered CallTool handler or its
 * stored schemas, so both are read through documented casts (as the register()
 * seam above already does for the SDK's untyped surface).
 */
type CallToolDispatch = (request: CallToolRequest, extra: unknown) => Promise<ToolResult>;
type McpInternals = {
  _registeredTools: Record<string, { inputSchema?: z.ZodType } | undefined>;
  server: { _requestHandlers: Map<string, CallToolDispatch> };
};

function guardInputSchemaVoice(server: McpServer): void {
  // The SDK exposes no public accessor for its registered schemas or CallTool
  // handler; both are read through this one documented cast.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const internals = server as unknown as McpInternals;
  // oxlint-disable-next-line eslint/no-underscore-dangle
  const tools = internals._registeredTools;
  const method = CallToolRequestSchema.shape.method.value;
  // oxlint-disable-next-line eslint/no-underscore-dangle
  const dispatch = internals.server._requestHandlers.get(method);
  if (dispatch === undefined) {
    throw new Error('MCP CallTool handler is not registered');
  }
  // Replace the stored handler directly instead of calling setRequestHandler:
  // that SDK helper parses CallToolRequestSchema before invoking our guard, and
  // z.record drops an own `__proto__` key during that parse. The original
  // dispatch retained below still performs the SDK's full request parse after
  // this raw-argument check and our tool-schema guard.
  // oxlint-disable-next-line eslint/no-underscore-dangle
  internals.server._requestHandlers.set(method, async (request, extra) => {
    // Preserve the original SDK dispatch for malformed outer requests. Its
    // stored handler owns CallToolRequestSchema's JSON-RPC validation and error
    // mapping; the raw wrapper only intervenes once that envelope is valid.
    const parsedRequest = CallToolRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      return dispatch(request, extra);
    }
    const name = parsedRequest.data.params.name;
    // An own-property test, not `tools[name] === undefined`: `tools` is a plain
    // object, so a prototype-named request (`constructor`, `toString`,
    // `__proto__`) would otherwise resolve an inherited Object.prototype value
    // — truthy, and schema-less — skipping straight to `dispatch` and re-leaking
    // the SDK's raw "Tool <name> disabled" text.
    if (!Object.hasOwn(tools, name)) {
      const { hint, message } = unknownToolVoice(name, Object.keys(tools));
      return toolErrorResult('not_found', message, hint);
    }
    const schema = tools[name]?.inputSchema;
    if (schema !== undefined) {
      const args = request.params.arguments ?? {};
      // Zod deliberately skips this special own key while walking an object,
      // so neither the request record nor strictObject can enforce the advertised
      // additionalProperties:false contract for JSON-decoded input on its own.
      if (Object.hasOwn(args, '__proto__')) {
        return toolErrorResult(
          'validation',
          "__proto__ isn't an argument",
          `check the arguments against the '${name}' tool schema`,
        );
      }
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        const { hint, message } = schemaMissVoice(name, parsed.error, args);
        return toolErrorResult('validation', message, hint);
      }
      // Write the coalesced value back so the SDK's own re-validation sees the
      // same object the guard accepted — an omitted `arguments` key reaches the
      // SDK as `undefined` and would re-leak zod text for all-optional tools.
      parsedRequest.data.params.arguments = args;
    }
    return dispatch(parsedRequest.data, extra);
  });
}

export function buildMcpServer(store: Store, version: string, boundScope?: string): McpServer {
  const server = new McpServer({ name: 'mimir', version });

  // Project Binding (ADR 0011): the spawn cwd's .mimir.toml supplies the
  // default scope, mirroring the CLI exactly — explicit scope wins, the
  // literal "all" escapes to every project (keys are uppercase; no collision).
  const applyScope = <A extends { scope?: string }>(args: A): A => {
    if (args.scope === 'all') {
      return { ...args, scope: undefined };
    }
    if (args.scope === undefined && boundScope !== undefined) {
      return { ...args, scope: boundScope };
    }
    return args;
  };

  // ---------------------------------------------------------------------------
  // Read tools
  // ---------------------------------------------------------------------------

  register(
    server,
    'next',
    'Ready tasks in rank order — what to work on next. Optionally scope to a project key; filter by case-insensitive title substring (q), priority/size, verdicts (is/notIs: stale|blocking|orphaned), and field operators (eq/notEq/in/notIn/has/missing + the date ops on/before/after/atOrBefore/atOrAfter, all FIELD:VALUE tokens). A bare YYYY-MM-DD date resolves through tz, your IANA timezone, which is required whenever a date carries no time. Value faults return an empty set plus a warnings array.',
    {
      limit: LIMIT.optional(),
      priority: PRIORITY.optional(),
      q: z.string().optional(),
      scope: z.string().optional(),
      size: SIZE.optional(),
      ...OPERATOR_SCHEMA,
    },
    (args: SetQueryArgs) => toolNext(store, applyScope(args)),
  );

  register(
    server,
    'list',
    'Broad selection: status picks the universe (ready|awaiting|in_progress|under_review|blocked|parked|done|abandoned or live|terminal|all; default live); case-insensitive title substring (q), verdicts (is/notIs), and field operators (FIELD:VALUE tokens, date ops on/before/after/atOrBefore/atOrAfter) filter within it — all AND-composed. A bare YYYY-MM-DD date resolves through tz, your IANA timezone, which is required whenever a date carries no time. Value faults return an empty set plus a warnings array.',
    {
      limit: LIMIT.optional(),
      priority: PRIORITY.optional(),
      q: z.string().optional(),
      scope: z.string().optional(),
      size: SIZE.optional(),
      status: STATUS.optional(),
      tag: z.string().optional(),
      ...OPERATOR_SCHEMA,
    },
    (args: SetQueryArgs) => toolList(store, applyScope(args)),
  );

  register(
    server,
    'get',
    "Full record by rendered id: a node (KEY-seq, e.g. MMR-16), a whole project (bare KEY), or an artifact (KEY-aN). Cheap facets are included for nodes/projects; add `history` for the transition log, `content` for an artifact's frozen body.",
    { facets: z.array(FACET).optional(), id: z.string() },
    (args: { id: string; facets?: (FacetName | 'content')[] }) => toolGet(store, args),
  );

  register(
    server,
    'status',
    'A rollup distribution and single status word, for a node (KEY-seq) or a whole project (bare KEY).',
    { id: z.string() },
    (args: { id: string }) => toolStatus(store, args),
  );

  register(
    server,
    'overview',
    'Session-boot orientation for ONE project (MMR-278): a header (project id, status word, rollup distribution), in-flight tasks (in_progress + under_review, uncapped), the ready-queue head (next, top 5), dependency-gated tasks (awaiting, top 5, each carrying the upstream ids it awaits), and hygiene counts (untriaged seeds, blocked, stale, dropped records). scope defaults to the bound board; "all" is rejected — a composite is one project, use list for a cross-project set. Every section carries its TRUE total even when its list is capped. Returns one composite JSON envelope.',
    { scope: z.string().optional() },
    (args: { scope?: string }) => toolOverview(store, args, boundScope),
  );

  register(
    server,
    'artifacts',
    'The artifact feed (MMR-322): frozen work products newest-first, metadata only — id, project, title, tags, the summary lede, created_at. Filters AND-compose: tag, the created_at date ops (on/before/after/atOrBefore/atOrAfter, each an array of FIELD:VALUE tokens like "created_at:2026-07-01"), q (case-insensitive substring over the title), plus limit/offset paging. A bare YYYY-MM-DD resolves through tz, your IANA timezone, which is required whenever a date has no time; a timestamp must carry Z or an offset. Unlike overview this IS a cross-project read — scope defaults to the bound board and "all" widens to every project. Read an artifact\'s frozen body with get KEY-aN and the content facet. Tag session_summary marks a session retrospective (ADR 0026).',
    {
      limit: LIMIT.optional(),
      offset: z.number().int().min(0).optional(),
      q: z.string().optional(),
      scope: z.string().optional(),
      tag: z.string().optional(),
      ...DATE_OPERATOR_SCHEMA,
    },
    (args: ArtifactQueryToolArgs) => toolArtifacts(store, applyScope(args)),
  );

  register(
    server,
    'scratch_create',
    'Create a temporary, project-owned Scratchpad. Defaults to the bound project and returns a compact mutation receipt.',
    {
      linked_work: z.array(z.string()).optional(),
      scope: z.string().optional(),
      title: z.string(),
    },
    (args: { linked_work?: string[]; scope?: string; title: string }) => {
      const scoped = applyScope(args);
      if (scoped.scope === undefined) {
        return Promise.resolve(
          toolErrorResult(
            'validation',
            'scratch_create requires a project scope',
            'pass scope or run from a bound workspace',
          ),
        );
      }
      return toolScratchCreate(store, { ...scoped, scope: scoped.scope });
    },
  );

  register(
    server,
    'scratch_list',
    'List active Scratchpads. Defaults to the bound project; scope "all" lists every project.',
    { scope: z.string().optional() },
    (args: { scope?: string }) => toolScratchList(store, applyScope(args)),
  );

  register(
    server,
    'scratch_get',
    'Read one full Scratchpad by UUID.',
    { id: z.string() },
    (args: { id: string }) => toolScratchGet(store, args),
  );

  const scratchMutation = { expected_updated_at: z.string(), id: z.string() };

  register(
    server,
    'scratch_update',
    'Update Scratchpad metadata. Omitted linked_work preserves links; an empty array clears them.',
    {
      ...scratchMutation,
      linked_work: z.array(z.string()).optional(),
      title: z.string().optional(),
    },
    (args: { expected_updated_at: string; id: string; linked_work?: string[]; title?: string }) =>
      toolScratchUpdate(store, args),
  );
  register(
    server,
    'scratch_checkpoint',
    'Append a Journal checkpoint and return a compact receipt.',
    { ...scratchMutation, content: z.string() },
    (args: { content: string; expected_updated_at: string; id: string }) =>
      toolScratchCheckpoint(store, args),
  );
  register(
    server,
    'scratch_agenda_add',
    'Append an open Agenda item and return a compact receipt.',
    { ...scratchMutation, content: z.string() },
    (args: { content: string; expected_updated_at: string; id: string }) =>
      toolScratchAgendaAdd(store, args),
  );
  register(
    server,
    'scratch_agenda_complete',
    'Complete an open Agenda item and return a compact receipt.',
    { ...scratchMutation, number: z.number().int().positive() },
    (args: { expected_updated_at: string; id: string; number: number }) =>
      toolScratchAgendaComplete(store, args),
  );
  register(
    server,
    'scratch_agenda_supersede',
    'Supersede an open Agenda item with a reason and return a compact receipt.',
    { ...scratchMutation, number: z.number().int().positive(), reason: z.string() },
    (args: { expected_updated_at: string; id: string; number: number; reason: string }) =>
      toolScratchAgendaSupersede(store, args),
  );
  register(
    server,
    'scratch_freeze',
    'Freeze a Scratchpad into a durable Artifact. Safe to retry after staged failure.',
    { ...scratchMutation, summary: z.string(), tags: z.array(z.string()).optional() },
    (args: { expected_updated_at: string; id: string; summary: string; tags?: string[] }) =>
      toolScratchFreeze(store, args),
  );
  register(
    server,
    'scratch_discard',
    'Discard a Scratchpad. Open Agenda items require force plus a reason.',
    { ...scratchMutation, force: z.boolean().optional(), reason: z.string().optional() },
    (args: { expected_updated_at: string; force?: boolean; id: string; reason?: string }) =>
      toolScratchDiscard(store, args),
  );

  // ---------------------------------------------------------------------------
  // Uniform mutation tools (ADR 0025 Decision 3) — one registration per registry
  // entry: lifecycle (start/submit/return/done/abandon/reopen), hold
  // (park/unpark/block/unblock), archive/unarchive. The description and schema
  // derive from the operation facts; the handler is the generic `toolUniform`.
  // Adding a uniform verb needs no edit here.
  // ---------------------------------------------------------------------------

  for (const spec of OP_SPECS) {
    register(
      server,
      spec.verb,
      uniformToolDescription(spec),
      uniformToolSchema(spec),
      (args: UniformToolArgs) => toolUniform(store, spec.verb, args),
    );
  }

  // ---------------------------------------------------------------------------
  // Dependency mutation tools
  // ---------------------------------------------------------------------------

  register(
    server,
    'depend',
    'Add dependency edges: id depends on each node in `on`. Acyclic — cycle attempts error. Echoes the subject node.',
    { id: z.string(), on: z.array(z.string()) },
    (args: { id: string; on: string[] }) => toolDepend(store, args),
  );

  register(
    server,
    'undepend',
    'Remove dependency edges from id to each node in `on`. Echoes the subject node.',
    { id: z.string(), on: z.array(z.string()) },
    (args: { id: string; on: string[] }) => toolUndepend(store, args),
  );

  // ---------------------------------------------------------------------------
  // Structure mutation tools
  // ---------------------------------------------------------------------------

  register(
    server,
    'move',
    'Re-parent a node under a new parent (within the same project). Echoes the moved node.',
    { id: z.string(), to: z.string() },
    (args: { id: string; to: string }) => toolMove(store, args),
  );

  register(
    server,
    'reorder',
    "Change a task's rank position (top|bottom|before|after). `ref` is required for before/after. Echoes the task.",
    {
      id: z.string(),
      position: z.enum(['top', 'bottom', 'before', 'after']),
      ref: z.string().optional(),
    },
    (args: { id: string; position: 'top' | 'bottom' | 'before' | 'after'; ref?: string }) =>
      toolReorder(store, args),
  );

  // ---------------------------------------------------------------------------
  // Data mutation tools
  // ---------------------------------------------------------------------------

  register(
    server,
    'update',
    "Patch a node's scalar fields (title, description, summary, priority, size, target, externalRef, upstream, openEnded, and the resume handles host/harness/session/branch), patch a project (KEY: name, description, next), patch an artifact (KEY-aN: title, summary), or patch a live seed (KEY-sN: title, kind, description). openEnded (a phase/initiative opt-out of done-rollup) applies only to containers; upstream (a KEY-sN seed pointer) only to tasks — pass the literal string 'none' to clear it (omit it to leave it untouched; blank is rejected). The resume handles are task-only in-flight metadata (set them on start; overwrite them here to resume or take over; a blank clears one). next is the owned direction narrative (the `## Next` body section) on a project, initiative, or phase — re-authored WHOLE on each write, never appended, and cleared by a blank string. Echoes the updated record.",
    // The scalar-field args derive from the field spec (ADR 0025); the bespoke
    // identity/topology args (id) and the non-node targets (title/description/
    // next, seed kind) stay hand-listed. Sorted to keep the advertised
    // alphabetical order.
    sortedShape({
      ...fieldInputShape(),
      description: z.string().optional(),
      id: z.string(),
      kind: SEED_KIND.optional(),
      next: z.string().optional(),
      title: z.string().optional(),
    }),
    (args: {
      id: string;
      title?: string;
      description?: string;
      next?: string;
      summary?: string;
      priority?: string;
      size?: string;
      target?: string;
      externalRef?: string;
      upstream?: string;
      host?: string;
      harness?: string;
      session?: string;
      branch?: string;
      kind?: string;
      openEnded?: boolean;
    }) => toolUpdate(store, args),
  );

  register(
    server,
    'annotate',
    'Append a freeform annotation to a node. Echoes the updated node.',
    { content: z.string(), id: z.string() },
    (args: { id: string; content: string }) => toolAnnotate(store, args),
  );

  // ---------------------------------------------------------------------------
  // Tag tools (MMR-31)
  // ---------------------------------------------------------------------------

  register(
    server,
    'tag',
    'Apply free-text tags to entities by rendered id (project KEY, node KEY-seq, artifact KEY-aN). Idempotent; a tag application carries no note. Not transition-logged.',
    {
      ids: z.array(z.string()).min(1),
      tags: z.array(z.string()).min(1),
    },
    (args: { ids: string[]; tags: string[] }) => toolTag(store, args),
  );

  register(
    server,
    'untag',
    'Remove tags from entities by rendered id. A plain row delete — not transition-logged.',
    { ids: z.array(z.string()).min(1), tags: z.array(z.string()).min(1) },
    (args: { ids: string[]; tags: string[] }) => toolUntag(store, args),
  );

  // ---------------------------------------------------------------------------
  // Create tool
  // ---------------------------------------------------------------------------

  register(
    server,
    'create',
    'Create a node of the given type. project: requires key+name, echoes {project:{key,name}}. initiative: requires title+parent (project KEY). phase/task: requires title+parent (KEY-seq node ref). Echoes the created node.',
    // Scalar-field args derive from the field spec (ADR 0025); the identity/topology
    // args (type/key/name/parent/title/tags) stay hand-listed. Sorted to keep order.
    sortedShape({
      ...fieldInputShape(),
      description: z.string().optional(),
      key: z.string().optional(),
      name: z.string().optional(),
      parent: z.string().optional(),
      tags: z.array(z.string()).optional(),
      title: z.string().optional(),
      type: z.enum(['project', 'initiative', 'phase', 'task']),
    }),
    (args: {
      type: 'project' | 'initiative' | 'phase' | 'task';
      key?: string;
      name?: string;
      parent?: string;
      title?: string;
      description?: string;
      summary?: string;
      target?: string;
      priority?: string;
      size?: string;
      externalRef?: string;
      upstream?: string;
      host?: string;
      harness?: string;
      session?: string;
      branch?: string;
      openEnded?: boolean;
      tags?: string[];
    }) => toolCreate(store, args),
  );

  // ---------------------------------------------------------------------------
  // Attach tool
  // ---------------------------------------------------------------------------

  register(
    server,
    'attach',
    'Store a frozen artifact (title + content, optional summary lede) and optionally link it to nodes and tag it. Infers project from linked nodes. Echoes {artifact:{id}} with the rendered KEY-aN id.',
    {
      content: z.string(),
      links: z.array(z.string()).optional(),
      node: z.string().optional(),
      project: z.string().optional(),
      summary: z.string().optional(),
      tags: z.array(z.string()).optional(),
      title: z.string(),
    },
    (args: {
      title: string;
      content: string;
      summary?: string;
      node?: string;
      project?: string;
      links?: string[];
      tags?: string[];
    }) => toolAttach(store, args),
  );

  // ---------------------------------------------------------------------------
  // Seed tools (MMR-245) — the grooming queue
  // ---------------------------------------------------------------------------

  register(
    server,
    'seed',
    'File a seed — an ask against ANOTHER board (a bug/feature you hit in a surface you do not own; the owning board triages it), or an own-board idea with no statable fix. NOT for work discovered on your own board: a statable fix is already triaged — create a task instead. kind is idea|bug|feature. project defaults to the bound board; a seed filed into a DIFFERENT board records the bound board as its requester (else self-filed). title is one capture blob: the first line is the title, the rest (after a newline) is the ## Seed Description body — the first line has a hard 120-char cap that errors. An explicit description wins over the blob split. Echoes the created seed.',
    {
      description: z.string().optional(),
      kind: SEED_KIND,
      project: z.string().optional(),
      title: z.string(),
    },
    (args: { title: string; kind: string; project?: string; description?: string }) =>
      toolSeed(store, args, boundScope),
  );

  register(
    server,
    'seeds',
    'The grooming queue — live seeds (new + promoted) oldest-first by default. project scopes to one board (default the bound board; "all" = every board); requester filters to a requesting board; status is new|promoted|resolved|rejected or live|all; sort is asc|desc (age). The created_at date ops (on/before/after/atOrBefore/atOrAfter, arrays of FIELD:VALUE tokens like "created_at:2026-07-01") window the queue by age; a bare YYYY-MM-DD needs tz, your IANA timezone.',
    {
      project: z.string().optional(),
      requester: z.string().optional(),
      sort: SEED_SORT.optional(),
      status: SEED_STATUS.optional(),
      ...DATE_OPERATOR_SCHEMA,
    },
    (args: SeedQueryToolArgs) => toolSeeds(store, args, boundScope),
  );

  register(
    server,
    'get_seed',
    'Full seed record by KEY-sN id — the resolved view (unknown requester nulled, dangling spawned pruned) plus the ## Seed Description prose. Distinct from `get`, which reads nodes/projects/artifacts.',
    { content: z.boolean().optional(), id: z.string() },
    (args: { id: string; content?: boolean }) => toolGetSeed(store, args),
  );

  register(
    server,
    'promote',
    'Germinate a seed (KEY-sN) into work. --parent creates a task under a phase/initiative (title/description default from the seed); --link records an EXISTING node (KEY-seq) as spawned without creating (mutually exclusive with parent). Appends the spawned link and moves new → promoted on the first promote (repeatable). Echoes the updated seed.',
    {
      description: z.string().optional(),
      id: z.string(),
      link: z.string().optional(),
      parent: z.string().optional(),
      priority: PRIORITY.optional(),
      size: SIZE.optional(),
      tags: z.array(z.string()).optional(),
      title: z.string().optional(),
    },
    (args: {
      id: string;
      parent?: string;
      link?: string;
      title?: string;
      description?: string;
      priority?: string;
      size?: string;
      tags?: string[];
    }) => toolPromote(store, args),
  );

  register(
    server,
    'reject',
    'Reject a seed (KEY-sN) — a terminal transition reachable from new or promoted; reason required. Echoes the updated seed.',
    { id: z.string(), reason: z.string() },
    (args: { id: string; reason: string }) => toolReject(store, args),
  );

  register(
    server,
    'resolve',
    'Resolve a seed (KEY-sN) — a terminal transition reachable from new or promoted; resolution reason required. Echoes the updated seed.',
    { id: z.string(), reason: z.string() },
    (args: { id: string; reason: string }) => toolResolve(store, args),
  );

  register(
    server,
    'triage',
    "Reconcile ONE board's grooming queue (MMR-246): (a) surface new/untriaged seeds, (b) flag promoted seeds whose spawned work has all settled (ready to resolve — never auto-closed), and (c) over the board's OWN tasks whose upstream seed went terminal, append an idempotent annotation recording the resolution and suggest unblock. WRITES the check-(c) annotations by default; NEVER transitions anything (unblock/resolve stay suggestions). dryRun previews with no writes. board defaults to the bound board. Idempotent — a re-run is a no-op. Returns the three-check report.",
    { board: z.string().optional(), dryRun: z.boolean().optional() },
    (args: { board?: string; dryRun?: boolean }) => toolTriage(store, args, boundScope),
  );

  // Intercept the SDK's pre-handler input validation and its unregistered-tool
  // fault so both speak house voice, not the SDK's raw text (MMR-292, MMR-296).
  // Installed last, over the fully-registered tool set.
  guardInputSchemaVoice(server);

  return server;
}

/** Serve over stdio — the entry for `mimir mcp`. */
export async function serveStdio(
  store: Store,
  version: string,
  boundScope?: string,
): Promise<void> {
  await buildMcpServer(store, version, boundScope).connect(new StdioServerTransport());
}
