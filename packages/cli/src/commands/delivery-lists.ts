/**
 * `limitation` and `decline`: the flat verbs that append to a delivery's two
 * lists (ADR 0042, MMR-691 refinement). Each calls one Engine method and
 * echoes the delivery as `get` reads it. Blank text and a missing or blank
 * reason reach the Engine, which refuses them as `validation`, so the CLI and
 * MCP refuse alike.
 */
import { Command } from '@loomcli/core';
import { helpCommand } from '@loomcli/plugins/help/extension';
import { mcpCommand } from '@loomcli/plugins/mcp/extension';
import { encodeDelivery } from '@mimir/contract';

import { asciiOption, text, writeHints } from '../options';
import { flagOrWords, reasonWords } from '../parse';
import type { Ports } from '../ports';
import { deliveryEchoViews } from '../render/deliveries';
import type { DeliveryValue } from '../render/deliveries';
import { presentationOf } from '../render/presentation';

const deliveryArgument = { description: 'The delivery (KEY-dN).', required: true } as const;

/** `limitation KEY-dN <text>` — an edge case the delivery ships knowingly. */
export function limitationVerb(ports: Ports) {
  return new Command('limitation', {
    description: 'Record a known limitation of a delivery: an edge case it ships knowingly.',
    extensions: [
      helpCommand({
        examples: [
          {
            command: 'limitation MMR-d3 "A cancelled run is charged its full reservation"',
            note: 'an edge case shipped on purpose',
          },
        ],
      }),
      mcpCommand({ annotations: writeHints }),
    ],
  })
    .argument('id', deliveryArgument)
    .argument('text', { description: 'The limitation, the rest of the line.', variadic: true })
    .option('ascii', asciiOption)
    .result<DeliveryValue>({ views: deliveryEchoViews })
    .views({ records: deliveryEchoViews.records }, { default: 'records' })
    .action(async ({ args, host, options, out }) => {
      const delivery = await (
        await ports.engine()
      ).deliveryLimitation({ id: args.id, text: reasonWords(args.text) });
      await out.results({
        delivery: encodeDelivery(delivery),
        presentation: presentationOf(host, options.ascii),
      });
    });
}

/** `decline KEY-dN <finding> <reason words | --reason>` — a review finding not acted on. */
export function declineVerb(ports: Ports) {
  return new Command('decline', {
    description: 'Record a review finding a delivery chose not to act on, with its reason.',
    extensions: [
      helpCommand({
        examples: [
          {
            command: 'decline MMR-d3 "Retry the clone on a fetch failure" "Filed as MMR-s55"',
            note: 'the finding, then why it was declined',
          },
          {
            command:
              'decline MMR-d3 "Retry the clone on a fetch failure" --reason "Filed as MMR-s55"',
            note: 'the reason as an option',
          },
        ],
      }),
      mcpCommand({ annotations: writeHints }),
    ],
  })
    .argument('id', deliveryArgument)
    .argument('finding', { description: 'The finding, quoted as one argument.', required: true })
    .argument('words', {
      description: 'Why it was declined, in place of --reason.',
      variadic: true,
    })
    .option('reason', text('Why it was declined, in place of the words after the finding.'))
    .option('ascii', asciiOption)
    .result<DeliveryValue>({ views: deliveryEchoViews })
    .views({ records: deliveryEchoViews.records }, { default: 'records' })
    .action(async ({ args, host, options, out }) => {
      const reason = flagOrWords(options.reason, args.words);
      const delivery = await (
        await ports.engine()
      ).deliveryDecline({ finding: args.finding, id: args.id, reason });
      await out.results({
        delivery: encodeDelivery(delivery),
        presentation: presentationOf(host, options.ascii),
      });
    });
}
