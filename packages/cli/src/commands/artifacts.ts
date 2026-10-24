/**
 * `artifacts`: one project's artifact feed, newest first, through the Engine's
 * `artifacts` read. Its one date field is `created_at`, so the date flags take
 * `created_at:DATE`.
 */
import { Command } from '@loomcli/core';
import { helpCommand, helpInput } from '@loomcli/plugins/help/extension';
import { mcpCommand } from '@loomcli/plugins/mcp/extension';
import { intentEncoders } from '@mimir/contract';
import type { ArtifactSummary, SetResult } from '@mimir/contract';

import { asciiOption, filterOption, scopeOption, tzOption } from '../options';
import { parseDateFeed, parseLimit, parseOffset, parseZone } from '../parse';
import type { Ports } from '../ports';
import { printNote } from '../query';
import { renderArtifactFeed } from '../render/feeds';
import { presentationOf } from '../render/presentation';
import type { Presentation } from '../render/presentation';
import { recordViews } from '../render/views';
import { boardProject } from '../scope';

/** The artifact feed's one date field. */
const DATE_FIELD = 'created_at';

/** The feed, its wire objects, and how the styled views render it. */
export type ArtifactsValue = {
  presentation: Presentation;
  result: SetResult<ArtifactSummary>;
  rows: Record<string, unknown>[];
  /** The `json` envelope: `{ returned, starts_at, total, artifacts }`. */
  wire: Record<string, unknown>;
};

const styled = (value: Readonly<ArtifactsValue>): string =>
  renderArtifactFeed(value.result, value.presentation);

const views = recordViews<ArtifactsValue>({
  ids: (value) => value.result.items.map((a) => a.id).join('\n'),
  json: (value) => value.wire,
  jsonl: (value) => value.rows,
  records: styled,
});

export function artifactsCommand(ports: Ports) {
  return new Command('artifacts', {
    description: "Read one project's artifact feed: frozen work products, newest first (KEY-aN).",
    extensions: [
      helpCommand({
        examples: [
          { command: 'artifacts', note: 'the bound project, newest first' },
          { command: 'artifacts -s MMR -t session_summary', note: 'session retrospectives' },
          { command: 'artifacts --at-or-after created_at:2026-07-01 -q auth', note: 'windowed' },
          { command: 'artifacts -f ids', note: 'the newest ids, for a get' },
        ],
      }),
      mcpCommand({ annotations: { openWorld: false, readOnly: true } }),
    ],
  })
    .option('scope', scopeOption)
    .option('tag', {
      description: 'Only artifacts carrying this tag.',
      extensions: [helpInput({ placeholder: 'tag' })],
      short: 't',
      type: 'string',
    })
    .option('before', filterOption('Only artifacts created before the date.', 'created_at:DATE'))
    .option('on', filterOption('Only artifacts created on the date.', 'created_at:DATE'))
    .option('after', filterOption('Only artifacts created after the date.', 'created_at:DATE'))
    .option(
      'at-or-before',
      filterOption('Only artifacts created at or before the instant.', 'created_at:DATE'),
    )
    .option(
      'at-or-after',
      filterOption('Only artifacts created at or after the instant.', 'created_at:DATE'),
    )
    .option('tz', tzOption)
    .option('query', {
      description: 'A case-insensitive substring of the title.',
      extensions: [helpInput({ placeholder: 'text' })],
      short: 'q',
      type: 'string',
    })
    .option('limit', {
      description: 'Cap the result count.',
      extensions: [helpInput({ placeholder: 'n' })],
      short: 'n',
      type: 'string',
    })
    .option('offset', {
      description: 'Rows to skip: pages the newest-first feed.',
      extensions: [helpInput({ placeholder: 'n' })],
      type: 'string',
    })
    .option('ascii', asciiOption)
    .result<ArtifactsValue>({ views })
    .views({ table: views.table }, { default: 'table' })
    .action(async ({ host, options, out }) => {
      // Every value is read before the store opens, so a wrong invocation never opens it.
      const zone = parseZone(ports.grammar, options.tz, host.timeZone);
      const dates = parseDateFeed(
        ports.grammar,
        {
          after: options.after,
          'at-or-after': options['at-or-after'],
          'at-or-before': options['at-or-before'],
          before: options.before,
          on: options.on,
        },
        DATE_FIELD,
        zone,
      );
      const limit = parseLimit(options.limit);
      const offset = parseOffset(options.offset);
      const notify = (line: string): void => {
        void out.print(line);
      };
      const project = await boardProject(ports, options.scope, 'artifacts', notify);
      const engine = await ports.engine();
      const result = intentEncoders.artifactSet.parse(
        await engine.artifacts({
          dates,
          limit,
          offset,
          project,
          q: options.query,
          tag: options.tag,
          timeZone: zone,
        }),
      );
      const presentation = presentationOf(host, options.ascii, zone);
      // Keyed off the returned rows, not the total: an offset past the end matches plenty and returns nothing.
      if (result.returned === 0) {
        await printNote(
          result.total > 0
            ? `no artifacts in ${project} past offset ${String(result.startsAt)} — ${String(result.total)} artifact${result.total === 1 ? '' : 's'} matched`
            : `no artifacts in ${project} — widen the window, or drop a filter`,
          Reflect.get(options, 'format'),
          presentation.plain,
          out,
        );
      }
      await out.results({
        presentation,
        result,
        rows: result.items.map((a) => ports.wire.artifactSummary(a)),
        wire: {
          artifacts: result.items.map((a) => ports.wire.artifactSummary(a)),
          returned: result.returned,
          starts_at: result.startsAt,
          total: result.total,
        },
      });
    });
}
