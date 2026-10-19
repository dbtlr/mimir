/**
 * What the node-set reads (`next`, `list`) share: the query-flag declarations,
 * the parse of their values into one Engine query, and the stderr warnings an
 * Engine query may return. Every value is read before the store opens, so a
 * wrong invocation never opens it.
 */
import type { Out, StringOption } from '@loomcli/core';
import { helpInput } from '@loomcli/plugins/help/extension';
import { intentEncoders } from '@mimir/contract';
import type {
  Engine,
  FacetName,
  FieldFilter,
  Priority,
  Size,
  VerdictSelector,
  ValueWarning,
} from '@mimir/contract';

import { filterOption } from './options';
import {
  parseFacets,
  parseFilters,
  parseLimit,
  parsePriority,
  parseSize,
  parseVerdicts,
  parseZone,
} from './parse';
import type { Ports } from './ports';
import { nodeSetValue } from './render/node-set';
import type { NodeSetValue } from './render/node-set';
import { noteLabel, presentationOf, warnGlyph } from './render/presentation';
import type { PresentationHost } from './render/presentation';
import { boardProject } from './scope';

/** The plain selectors and the cap of a node-set read, declared once for `next` and `list`. */
export const nodeQueryOptions = {
  limit: {
    description: 'Cap the result count.',
    extensions: [helpInput({ placeholder: 'n' })],
    short: 'n',
    type: 'string',
  },
  priority: {
    description: 'Only this priority (a signal, not a sort): p0, p1, p2, or p3.',
    extensions: [helpInput({ placeholder: 'p0..p3' })],
    short: 'p',
    type: 'string',
  },
  query: {
    description: 'A case-insensitive substring of the title or id.',
    extensions: [helpInput({ placeholder: 'text' })],
    short: 'q',
    type: 'string',
  },
  size: {
    description: 'Only this size: s, m, or l.',
    extensions: [helpInput({ placeholder: 's|m|l' })],
    type: 'string',
  },
} satisfies Record<string, StringOption>;

/** The filter flags of a node-set read, each described over `noun` (`tasks`, `projects`). */
export function filterOptions(noun: string) {
  return {
    after: filterOption(`Only ${noun} whose date field falls after the date.`, 'FIELD:DATE'),
    'at-or-after': filterOption(
      `Only ${noun} whose date field falls at or after the instant.`,
      'FIELD:DATE',
    ),
    'at-or-before': filterOption(
      `Only ${noun} whose date field falls at or before the instant.`,
      'FIELD:DATE',
    ),
    before: filterOption(`Only ${noun} whose date field falls before the date.`, 'FIELD:DATE'),
    eq: filterOption(`Only ${noun} whose field equals the value.`),
    has: filterOption(`Only ${noun} whose field is set.`, 'FIELD'),
    in: filterOption(`Only ${noun} whose field is one of the comma-separated values.`),
    is: filterOption(
      `Only ${noun} this verdict holds for: stale, blocking, or orphaned.`,
      'verdict',
    ),
    missing: filterOption(`Only ${noun} whose field is unset.`, 'FIELD'),
    'not-eq': filterOption(`Only ${noun} whose field differs from the value.`),
    'not-in': filterOption(`Only ${noun} whose field is none of the comma-separated values.`),
    'not-is': filterOption(`Only ${noun} this verdict does not hold for.`, 'verdict'),
    on: filterOption(`Only ${noun} whose date field falls on the date.`, 'FIELD:DATE'),
  };
}

/** The option values a node-set read parses; Loom types each declaration to one of these. */
export type NodeQueryOptions = {
  after: readonly string[];
  'at-or-after': readonly string[];
  'at-or-before': readonly string[];
  before: readonly string[];
  col: readonly string[];
  eq: readonly string[];
  has: readonly string[];
  in: readonly string[];
  is: readonly string[];
  limit?: string | undefined;
  missing: readonly string[];
  'not-eq': readonly string[];
  'not-in': readonly string[];
  'not-is': readonly string[];
  on: readonly string[];
  priority?: string | undefined;
  query?: string | undefined;
  size?: string | undefined;
  tz?: string | undefined;
};

/** The parsed query a node-set read hands the Engine, minus its project and status. */
export type NodeQuery = {
  facets: FacetName[];
  filters: FieldFilter[];
  limit: number | undefined;
  priority: Priority | undefined;
  q: string | undefined;
  size: Size | undefined;
  timeZone: string;
  verdicts: VerdictSelector[];
};

/** Parse every query flag of `verb` into the Engine's query, refusing a bad value as usage. */
export function parseNodeQuery(
  ports: Ports,
  options: Readonly<NodeQueryOptions>,
  hostZone: string,
  verb: 'next' | 'list',
): NodeQuery {
  const facets = parseFacets(options.col, verb);
  const zone = parseZone(ports.grammar, options.tz, hostZone);
  return {
    facets,
    filters: parseFilters(
      ports.grammar,
      {
        after: options.after,
        'at-or-after': options['at-or-after'],
        'at-or-before': options['at-or-before'],
        before: options.before,
        eq: options.eq,
        has: options.has,
        in: options.in,
        missing: options.missing,
        'not-eq': options['not-eq'],
        'not-in': options['not-in'],
        on: options.on,
      },
      zone,
    ),
    limit: parseLimit(options.limit),
    priority: parsePriority(options.priority),
    q: options.query,
    size: parseSize(options.size),
    timeZone: zone,
    verdicts: parseVerdicts(options.is, options['not-is']),
  };
}

/** What a node-set action reads from Loom's action context. */
export type NodeSetAction = {
  host: PresentationHost;
  options: Readonly<NodeQueryOptions> & { ascii: boolean; scope?: string | undefined };
  out: Out<{ kind: 'value'; value: NodeSetValue }>;
};

/**
 * The action `next` and `list` share: parse the query, resolve the project,
 * make the Engine call `bind` returns, and print the set. `bind` runs before
 * the store opens, so it parses whatever else the verb reads; `empty` is the
 * line a terminal prints for an empty set.
 */
export async function readNodeSet(
  ports: Ports,
  { host, options, out }: NodeSetAction,
  verb: 'next' | 'list',
  empty: (project: string) => string,
  bind: (query: NodeQuery) => (engine: Engine, project: string) => Promise<unknown>,
): Promise<void> {
  const query = parseNodeQuery(ports, options, host.timeZone, verb);
  const call = bind(query);
  const notify = (line: string): void => {
    void out.print(line);
  };
  const project = await boardProject(ports, options.scope, verb, notify);
  const engine = await ports.engine();
  const result = intentEncoders.nodeSet.parse(await call(engine, project));
  const presentation = presentationOf(host, options.ascii, query.timeZone);
  if (result.warnings !== undefined && result.warnings.length > 0) {
    await printWarnings(result.warnings, Reflect.get(options, 'format'), presentation.plain, out);
  }
  await out.results(nodeSetValue(ports, result, presentation, 'task', empty(project)));
}

/**
 * One stderr note for a well-formed query that matched nothing (ADR 0009): a
 * JSON line under a JSON format, else a warning line, so stdout stays a clean
 * machine contract.
 */
export async function printNote(
  message: string,
  format: unknown,
  plain: boolean,
  out: Out,
): Promise<void> {
  await out.print(
    format === 'json' || format === 'jsonl'
      ? JSON.stringify({ warning: message })
      : `${warnGlyph(plain)} ${message}`,
  );
}

/** A query's value warnings on stderr: a JSON line per warning under a JSON format, else prose. */
export async function printWarnings(
  warnings: readonly ValueWarning[],
  format: unknown,
  plain: boolean,
  out: Out,
): Promise<void> {
  for (const warning of warnings) {
    if (format === 'json' || format === 'jsonl') {
      await out.print(JSON.stringify({ warning }));
      continue;
    }
    await out.print(
      `${warnGlyph(plain)} ${warning.message}\n${noteLabel(plain)} expected ${warning.expected.join(', ')}`,
    );
  }
}
