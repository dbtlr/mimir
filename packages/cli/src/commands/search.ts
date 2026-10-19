/**
 * `search <query…>`: find any record of one project (task, container, seed,
 * artifact) by id, title, or description, through the Engine's `search` read.
 * The words after the verb are the query.
 */
import { Command } from '@loomcli/core';
import { helpCommand, helpInput } from '@loomcli/plugins/help/extension';
import { mcpCommand } from '@loomcli/plugins/mcp/extension';
import { intentEncoders } from '@mimir/contract';
import type { SearchHit, SetResult } from '@mimir/contract';

import { MimirUsageError } from '../failures';
import { asciiOption, scopeOption } from '../options';
import { parseSearchLimit } from '../parse';
import type { Ports } from '../ports';
import { printNote } from '../query';
import { renderSearchSet } from '../render/feeds';
import { presentationOf } from '../render/presentation';
import type { Presentation } from '../render/presentation';
import { compactJson, prettyJson, recordViews } from '../render/views';
import { boardProject } from '../scope';

/** The hits, their wire objects, and how the styled views render them. */
export type SearchValue = {
  presentation: Presentation;
  result: SetResult<SearchHit>;
  rows: Record<string, unknown>[];
  /** The `json` envelope: `{ results, returned, starts_at, total }`. */
  wire: Record<string, unknown>;
};

const styled = (value: Readonly<SearchValue>): string =>
  renderSearchSet(value.result, value.presentation);

const views = recordViews<SearchValue>({
  ids: (value) => value.result.items.map((h) => h.id).join('\n'),
  json: (value) => prettyJson(value.wire),
  jsonl: (value) => value.rows.map(compactJson).join('\n'),
  records: styled,
});

export function searchCommand(ports: Ports) {
  return new Command('search', {
    description:
      'Find any record of one project (task, container, seed, artifact) by id, title, or description.',
    extensions: [
      helpCommand({
        examples: [
          { command: 'search MMR-447', note: 'that record, plus what links to it' },
          { command: 'search 447', note: 'a bare number resolves in the project' },
          { command: 'search "cross record" -s MMR', note: 'titles and descriptions' },
          { command: 'search auth -n 5 -f json', note: 'structured output, five results' },
        ],
      }),
      mcpCommand({ annotations: { openWorld: false, readOnly: true } }),
    ],
  })
    .argument('query', {
      description: 'The words to find: an id, or text from a title or description.',
      required: true,
      variadic: true,
    })
    .option('scope', scopeOption)
    .option('limit', {
      description: 'Cap the result count.',
      extensions: [helpInput({ placeholder: 'n' })],
      short: 'n',
      type: 'string',
    })
    .option('ascii', asciiOption)
    .result<SearchValue>({ views })
    .views({}, { default: 'table' })
    .action(async ({ args, host, options, out }) => {
      // Every value is read before the store opens, so a wrong invocation never opens it.
      const query = args.query.join(' ').trim();
      if (query === '') {
        throw new MimirUsageError(
          'search needs a query',
          "e.g. 'mimir search MMR-12' or 'mimir search auth'",
        );
      }
      const limit = parseSearchLimit(options.limit, ports.grammar.maxSearchLimit);
      const notify = (line: string): void => {
        void out.print(line);
      };
      const project = await boardProject(ports, options.scope, 'search', notify);
      const engine = await ports.engine();
      const result = intentEncoders.searchSet.parse(await engine.search({ limit, project, query }));
      const presentation = presentationOf(host, options.ascii);
      if (result.returned === 0) {
        await printNote(
          `nothing matches '${query}' in ${project} — try fewer or different words`,
          Reflect.get(options, 'format'),
          presentation.plain,
          out,
        );
      }
      await out.results({
        presentation,
        result,
        rows: result.items.map((h) => ports.wire.searchHit(h)),
        wire: {
          results: result.items.map((h) => ports.wire.searchHit(h)),
          returned: result.returned,
          starts_at: result.startsAt,
          total: result.total,
        },
      });
    });
}
