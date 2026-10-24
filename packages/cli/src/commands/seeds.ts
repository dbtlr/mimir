/**
 * `seeds`: one project's grooming queue, oldest-first, through the Engine's
 * `seeds` read. `-p, --project` names the board as the old CLI did; `-s` is
 * accepted too, and `--project` wins. The seed feed's one date field is
 * `created_at`.
 */
import { Command } from '@loomcli/core';
import { helpCommand, helpInput } from '@loomcli/plugins/help/extension';
import { mcpCommand } from '@loomcli/plugins/mcp/extension';
import { intentEncoders } from '@mimir/contract';
import type { SeedView } from '@mimir/contract';

import { asciiOption, filterOption, scopeOption, tzOption } from '../options';
import { parseDateFeed, parseSeedSort, parseSeedStatus, parseZone } from '../parse';
import type { Ports } from '../ports';
import { renderSeedLanes, renderSeedQueue } from '../render/feeds';
import { presentationOf } from '../render/presentation';
import type { Presentation } from '../render/presentation';
import { compactJson, prettyJson, recordViews } from '../render/views';
import { boardProject } from '../scope';

const DATE_FIELD = 'created_at';
const EMPTY = 'No seeds — file one with mimir seed "…" -k <kind>';

/** The queue, its wire objects, and how the styled views render it. */
export type SeedsValue = {
  grouped: boolean;
  presentation: Presentation;
  seeds: SeedView[];
  rows: Record<string, unknown>[];
  /** The `json` envelope: `{ seeds, total }`. */
  wire: Record<string, unknown>;
};

const styled = (value: Readonly<SeedsValue>): string =>
  value.grouped
    ? renderSeedLanes(value.seeds, value.presentation)
    : renderSeedQueue(value.seeds, value.presentation, EMPTY);

const views = recordViews<SeedsValue>({
  ids: (value) => value.seeds.map((s) => s.id).join('\n'),
  json: (value) => prettyJson(value.wire),
  jsonl: (value) => value.rows.map(compactJson).join('\n'),
  records: styled,
});

export function seedsCommand(ports: Ports) {
  return new Command('seeds', {
    description: "Read one project's grooming queue: live seeds oldest-first (FIFO triage).",
    extensions: [
      helpCommand({
        examples: [
          { command: 'seeds', note: "the bound board's live queue, oldest-first" },
          {
            command: 'seeds --grouped',
            note: 'the lane view: untriaged, ready to resolve, settled',
          },
          { command: 'seeds --status all --grouped', note: 'every lane, parked included' },
          { command: 'seeds --status all --sort desc', note: 'every seed, newest-first' },
          { command: 'seeds --requester MMR', note: 'seeds MMR filed on other boards' },
          {
            command: 'seeds --at-or-after created_at:2026-07-01',
            note: 'filed this month or later',
          },
        ],
      }),
      mcpCommand({ annotations: { openWorld: false, readOnly: true } }),
    ],
  })
    .option('project', {
      description: 'The board whose queue to read. Defaults to the clone binding.',
      extensions: [helpInput({ placeholder: 'KEY' })],
      short: 'p',
      type: 'string',
    })
    .option('scope', scopeOption)
    .option('requester', {
      description: 'Only seeds this board requested.',
      extensions: [helpInput({ placeholder: 'KEY' })],
      type: 'string',
    })
    .option('status', {
      description:
        'new, parked, promoted, resolved, rejected, live (new and promoted), or all. Defaults to live.',
      extensions: [helpInput({ placeholder: 's' })],
      type: 'string',
    })
    .option('sort', {
      description: 'Age order. Defaults to asc, oldest-first.',
      extensions: [helpInput({ placeholder: 'asc|desc' })],
      type: 'string',
    })
    .option('before', filterOption('Only seeds filed before the date.', 'created_at:DATE'))
    .option('on', filterOption('Only seeds filed on the date.', 'created_at:DATE'))
    .option('after', filterOption('Only seeds filed after the date.', 'created_at:DATE'))
    .option(
      'at-or-before',
      filterOption('Only seeds filed at or before the instant.', 'created_at:DATE'),
    )
    .option(
      'at-or-after',
      filterOption('Only seeds filed at or after the instant.', 'created_at:DATE'),
    )
    .option('tz', tzOption)
    .option('grouped', { description: 'Render the lane view with counts.', type: 'boolean' })
    .option('ascii', asciiOption)
    .result<SeedsValue>({ views })
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
      const status = parseSeedStatus(options.status);
      const sort = parseSeedSort(options.sort);
      const notify = (line: string): void => {
        void out.print(line);
      };
      const project = await boardProject(ports, options.project ?? options.scope, 'seeds', notify);
      const engine = await ports.engine();
      const seeds = intentEncoders.seeds.parse(
        await engine.seeds({
          dates,
          project,
          requester: options.requester,
          sort,
          status,
          timeZone: zone,
        }),
      );
      const rows = seeds.map((s) => ports.wire.seed(s));
      await out.results({
        grouped: options.grouped,
        presentation: presentationOf(host, options.ascii, zone),
        rows,
        seeds,
        wire: { seeds: rows, total: seeds.length },
      });
    });
}
