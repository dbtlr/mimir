/**
 * `overview`: the session-boot orientation composite for one project, through
 * the Engine's `overview` read. A composite is neither a table nor an id set,
 * so it declares `records`, `json`, and a compact `jsonl` of the same document:
 * `records` on a terminal, `json` when piped.
 */
import { Command } from '@loomcli/core';
import { helpCommand } from '@loomcli/plugins/help/extension';
import { mcpCommand } from '@loomcli/plugins/mcp/extension';
import { intentEncoders } from '@mimir/contract';
import type { OverviewReport } from '@mimir/contract';

import { defaultFormat } from '../default-format';
import { asciiOption, scopeOption } from '../options';
import type { Ports } from '../ports';
import { presentationOf } from '../render/presentation';
import type { Presentation } from '../render/presentation';
import { renderOverview } from '../render/report';
import { compactJson, prettyJson, recordViews } from '../render/views';
import { boardProject } from '../scope';

/** The composite, its wire object, and how `records` renders it. */
export type OverviewValue = {
  presentation: Presentation;
  report: OverviewReport;
  wire: Record<string, unknown>;
};

// `jsonl` is declared so Loom's formatter does not derive one from the whole value.
const views = recordViews<OverviewValue>({
  json: (value) => prettyJson(value.wire),
  jsonl: (value) => compactJson(value.wire),
  records: (value) => renderOverview(value.report, value.presentation),
  table: false,
});

export function overviewCommand(ports: Ports) {
  return new Command('overview', {
    description:
      'Orient in one project: direction, in flight, next, awaiting, recent sessions, and hygiene.',
    extensions: [
      defaultFormat({ piped: 'json', terminal: 'records' }),
      helpCommand({
        examples: [
          { command: 'overview', note: 'orient in the bound project' },
          { command: 'overview -s MMR', note: 'orient in a specific project' },
          { command: 'overview -f json', note: 'the composite envelope for scripts' },
        ],
      }),
      mcpCommand({ annotations: { openWorld: false, readOnly: true } }),
    ],
  })
    .option('scope', scopeOption)
    .option('ascii', asciiOption)
    .result<OverviewValue>({ views })
    .views({ json: views.json }, { default: 'json' })
    .action(async ({ host, options, out }) => {
      const notify = (line: string): void => {
        void out.print(line);
      };
      const project = await boardProject(ports, options.scope, 'overview', notify);
      const engine = await ports.engine();
      const report = intentEncoders.overview.parse(await engine.overview({ project }));
      await out.results({
        presentation: presentationOf(host, options.ascii),
        report,
        wire: ports.wire.overview(report),
      });
    });
}
