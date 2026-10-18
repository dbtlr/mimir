/**
 * `next`: the ready tasks of one project, in rank order, through the Engine's
 * `next` read and the shared query grammar.
 */
import { Command } from '@loomcli/core';
import type { Out } from '@loomcli/core';
import { helpCommand, helpInput } from '@loomcli/plugins/help/extension';
import { mcpCommand } from '@loomcli/plugins/mcp/extension';
import { intentEncoders } from '@mimir/contract';
import type { NodeView, SetResult, ValueWarning } from '@mimir/contract';

import { asciiOption, colOption, filterOption, scopeOption, tzOption } from '../options';
import {
  parseFacets,
  parseFilters,
  parseLimit,
  parsePriority,
  parseSize,
  parseVerdicts,
  parseZone,
} from '../parse';
import type { Ports } from '../ports';
import { renderRecords, renderTable } from '../render/node';
import { noteLabel, presentationOf, warnGlyph } from '../render/presentation';
import type { Presentation } from '../render/presentation';
import { jsonView, textView } from '../render/views';
import { boardProject } from '../scope';

/** The ready set, its wire objects, and how the styled views render it. */
export type NextValue = {
  result: SetResult<NodeView>;
  /** The `json` envelope: `{ returned, starts_at, total, tasks }`. */
  wire: Record<string, unknown>;
  /** One wire object per task, for `jsonl`. */
  rows: Record<string, unknown>[];
  presentation: Presentation;
  /** What a terminal prints for an empty set. */
  emptyMessage: string;
};

function recordsOf(value: Readonly<NextValue>): string {
  if (value.result.items.length === 0 && value.presentation.isTTY) {
    return value.emptyMessage;
  }
  return value.result.items.map((n) => renderRecords(n, value.presentation)).join('\n\n');
}

const views = {
  ids: textView((value: Readonly<NextValue>) => value.result.items.map((n) => n.id).join('\n')),
  json: jsonView('application/json', (value: Readonly<NextValue>) =>
    JSON.stringify(value.wire, null, 2),
  ),
  jsonl: jsonView('application/jsonl', (value: Readonly<NextValue>) =>
    value.rows.map((row) => JSON.stringify(row)).join('\n'),
  ),
  records: textView(recordsOf),
  table: textView((value: Readonly<NextValue>) =>
    renderTable(value.result, value.presentation, 'task', value.emptyMessage),
  ),
};

/** A query's value warnings on stderr: a JSON line per warning under a JSON format, else prose. */
async function printWarnings(
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

export function nextCommand(ports: Ports) {
  return new Command('next', {
    description: 'List the ready tasks of one project in rank order.',
    extensions: [
      helpCommand({
        examples: [
          { command: 'next -s MMR', note: 'what to work on next in project MMR' },
          { command: 'next -q auth', note: 'ready tasks whose titles contain auth' },
          { command: 'next -p p0', note: 'the highest-priority ready tasks' },
          { command: 'next --format json', note: 'structured output for scripts' },
        ],
      }),
      mcpCommand({ annotations: { openWorld: false, readOnly: true } }),
    ],
  })
    .option('scope', scopeOption)
    .option('query', {
      description: 'A case-insensitive substring of the title or id.',
      extensions: [helpInput({ placeholder: 'text' })],
      short: 'q',
      type: 'string',
    })
    .option('priority', {
      description: 'Only this priority (a signal, not a sort): p0, p1, p2, or p3.',
      extensions: [helpInput({ placeholder: 'p0..p3' })],
      short: 'p',
      type: 'string',
    })
    .option('size', {
      description: 'Only this size: s, m, or l.',
      extensions: [helpInput({ placeholder: 's|m|l' })],
      type: 'string',
    })
    .option(
      'is',
      filterOption('Only tasks this verdict holds for: stale, blocking, or orphaned.', 'verdict'),
    )
    .option('not-is', filterOption('Only tasks this verdict does not hold for.', 'verdict'))
    .option('eq', filterOption('Only tasks whose field equals the value.'))
    .option('not-eq', filterOption('Only tasks whose field differs from the value.'))
    .option('in', filterOption('Only tasks whose field is one of the comma-separated values.'))
    .option('not-in', filterOption('Only tasks whose field is none of the comma-separated values.'))
    .option('has', filterOption('Only tasks whose field is set.', 'FIELD'))
    .option('missing', filterOption('Only tasks whose field is unset.', 'FIELD'))
    .option(
      'before',
      filterOption('Only tasks whose date field falls before the date.', 'FIELD:DATE'),
    )
    .option('on', filterOption('Only tasks whose date field falls on the date.', 'FIELD:DATE'))
    .option(
      'after',
      filterOption('Only tasks whose date field falls after the date.', 'FIELD:DATE'),
    )
    .option(
      'at-or-before',
      filterOption('Only tasks whose date field falls at or before the instant.', 'FIELD:DATE'),
    )
    .option(
      'at-or-after',
      filterOption('Only tasks whose date field falls at or after the instant.', 'FIELD:DATE'),
    )
    .option('tz', tzOption)
    .option('limit', {
      description: 'Cap the result count.',
      extensions: [helpInput({ placeholder: 'n' })],
      short: 'n',
      type: 'string',
    })
    .option('col', colOption)
    .option('ascii', asciiOption)
    .result<NextValue>({ views })
    .views({}, { default: 'table' })
    .action(async ({ host, options, out }) => {
      // Every value is read before the store opens, so a wrong invocation never opens it.
      const facets = parseFacets(options.col, 'next');
      const zone = parseZone(ports.grammar, options.tz, host.timeZone);
      const query = {
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
      const notify = (line: string): void => {
        void out.print(line);
      };
      const project = await boardProject(ports, options.scope, 'next', notify);
      const engine = await ports.engine();
      const result = intentEncoders.nodeSet.parse(await engine.next({ ...query, project }));
      const presentation = presentationOf(host, options.ascii, zone);
      if (result.warnings !== undefined && result.warnings.length > 0) {
        await printWarnings(
          result.warnings,
          Reflect.get(options, 'format'),
          presentation.plain,
          out,
        );
      }
      await out.results({
        emptyMessage: `No ready tasks in ${project} — mimir list --status awaiting -s ${project} shows what's queued`,
        presentation,
        result,
        rows: result.items.map((node) => ports.wire.node(node)),
        wire: ports.wire.set(result, 'tasks'),
      });
    });
}
