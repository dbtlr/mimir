/**
 * `scratch`: the Scratchpad group. This port carries its two reads, `list`
 * (one project's pads) and `get` (one pad by UUID), through the Engine's
 * `scratchList` and `scratchGet`.
 */
import { Command } from '@loomcli/core';
import { helpCommand } from '@loomcli/plugins/help/extension';
import { mcpCommand } from '@loomcli/plugins/mcp/extension';
import { intentEncoders } from '@mimir/contract';

import { asciiOption, scopeOption } from '../options';
import type { Ports } from '../ports';
import { presentationOf } from '../render/presentation';
import type { Presentation } from '../render/presentation';
import { renderScratchpad, renderScratchRows } from '../render/scratch';
import { compactJson, recordViews } from '../render/views';
import { boardProject } from '../scope';

/** The pads of one project, as the wire rows `json`, `jsonl`, and `ids` print. */
export type ScratchListValue = { rows: Record<string, unknown>[] };

// The old CLI printed the scratchpad reads' `json` on one line, unlike every other read.
const listViews = recordViews<ScratchListValue>({
  ids: (value) => value.rows.map((r) => r.id).join('\n'),
  json: (value) => compactJson({ scratchpads: value.rows, total: value.rows.length }),
  jsonl: (value) => value.rows.map(compactJson).join('\n'),
  records: (value) => renderScratchRows(value.rows),
});

function scratchListCommand(ports: Ports) {
  return new Command('list', {
    description: "List one project's active scratchpads, freezing first and newest first.",
    extensions: [
      helpCommand({
        examples: [
          { command: 'scratch list', note: "the bound project's pads" },
          { command: 'scratch list -s MMR -f json', note: 'structured output for scripts' },
        ],
      }),
      mcpCommand({ annotations: { openWorld: false, readOnly: true } }),
    ],
  })
    .option('scope', scopeOption)
    .result<ScratchListValue>({ views: listViews })
    .views({}, { default: 'table' })
    .action(async ({ options, out }) => {
      const notify = (line: string): void => {
        void out.print(line);
      };
      const project = await boardProject(ports, options.scope, 'scratch list', notify);
      const engine = await ports.engine();
      const pads = intentEncoders.scratchpadRows.parse(await engine.scratchList({ project }));
      await out.results({ rows: pads.map((pad) => ports.wire.scratchRow(pad)) });
    });
}

/** One pad, its wire object, and how the styled views render it. */
export type ScratchGetValue = {
  presentation: Presentation;
  wire: Record<string, unknown>;
};

const getText = (value: Readonly<ScratchGetValue>): string =>
  renderScratchpad(value.wire, value.presentation);

const getViews = recordViews<ScratchGetValue>({
  ids: (value) => String(value.wire.id),
  json: (value) => compactJson(value.wire),
  records: getText,
});

function scratchGetCommand(ports: Ports) {
  return new Command('get', {
    description: 'Read one scratchpad by UUID: its agenda, journal, and linked work.',
    extensions: [
      helpCommand({ examples: [{ command: 'scratch get 0d6c3f1e-…', note: 'one pad in full' }] }),
      mcpCommand({ annotations: { openWorld: false, readOnly: true } }),
    ],
  })
    .argument('id', { description: 'The scratchpad UUID.', required: true })
    .option('ascii', asciiOption)
    .result<ScratchGetValue>({ views: getViews })
    .views({}, { default: 'records' })
    .action(async ({ args, host, options, out }) => {
      const engine = await ports.engine();
      const pad = intentEncoders.scratchpad.parse(await engine.scratchGet({ id: args.id }));
      await out.results({
        presentation: presentationOf(host, options.ascii),
        wire: ports.wire.scratchpad(pad),
      });
    });
}

export function scratchCommand(ports: Ports) {
  return new Command('scratch', {
    description: 'Read and keep Scratchpads, the working state of one episode.',
  })
    .command(scratchListCommand(ports))
    .command(scratchGetCommand(ports));
}
