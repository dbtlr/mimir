/**
 * `status <id>`: the rollup status word and distribution of a task, container,
 * or project, through the Engine's `status` read. It is structured data, so
 * `json` is its default on every destination.
 */
import { Command } from '@loomcli/core';
import { helpCommand } from '@loomcli/plugins/help/extension';
import { mcpCommand } from '@loomcli/plugins/mcp/extension';
import { intentEncoders } from '@mimir/contract';
import type { StatusView } from '@mimir/contract';

import { asciiOption } from '../options';
import type { Ports } from '../ports';
import { presentationOf } from '../render/presentation';
import type { Presentation } from '../render/presentation';
import { renderStatus } from '../render/report';
import { recordViews } from '../render/views';

/** The status read and how the styled views render it. */
export type StatusValue = { presentation: Presentation; status: StatusView };

const text = (value: Readonly<StatusValue>): string =>
  renderStatus(value.status, value.presentation);

/** The wire object: the label and distribution with the id. */
const wireOf = (value: Readonly<StatusValue>) => ({
  distribution: value.status.distribution,
  id: value.status.id,
  status: value.status.status,
});

// `jsonl` is declared so Loom's formatter does not derive one from the whole value.
const views = recordViews<StatusValue>({
  json: wireOf,
  jsonl: 'compact',
  records: text,
});

export function statusCommand(ports: Ports) {
  return new Command('status', {
    description: 'Read the rollup status and distribution of a node (KEY-seq) or project (KEY).',
    extensions: [
      helpCommand({
        examples: [{ command: 'status MMR-3', note: 'the rollup of an initiative or phase' }],
      }),
      mcpCommand({ annotations: { openWorld: false, readOnly: true } }),
    ],
  })
    .argument('id', { description: 'KEY-seq or KEY.', required: true })
    .option('ascii', asciiOption)
    .result<StatusValue>({ views })
    .views({ json: views.json }, { default: 'json' })
    .action(async ({ args, host, options, out }) => {
      const engine = await ports.engine();
      const status = intentEncoders.status.parse(await engine.status({ id: args.id }));
      await out.results({ presentation: presentationOf(host, options.ascii), status });
    });
}
