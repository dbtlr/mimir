import { Command } from '@loomcli/core';
import { helpCommand } from '@loomcli/plugins/help/extension';
import { mcpCommand } from '@loomcli/plugins/mcp/extension';
import { blankProse, DELIVERY_INT_MAX, encodeDelivery, MimirError } from '@mimir/contract';
import type { DeliveryView } from '@mimir/contract';

import { MimirUsageError } from '../failures';
import { asciiOption, text, writeHints } from '../options';
import type { Ports } from '../ports';
import { renderDelivery } from '../render/deliveries';
import { presentationOf } from '../render/presentation';
import type { Presentation } from '../render/presentation';
import { recordViews } from '../render/views';
import { boardProject } from '../scope';
import { requireTitle } from './create';

/**
 * `--time-cap <minutes|none>`: a plain positive decimal whole number within
 * the stored int32 range, `null` for `none`, or `undefined` when absent. Hex,
 * exponents, signs, and padding are refused rather than read as a number.
 */
export function parseTimeCap(value: string | undefined): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === 'none') {
    return null;
  }
  const minutes = /^[1-9]\d*$/.test(value) ? Number(value) : Number.NaN;
  if (!(minutes <= DELIVERY_INT_MAX)) {
    throw new MimirUsageError(
      `--time-cap requires a positive whole number of minutes up to ${String(DELIVERY_INT_MAX)}, or none`,
    );
  }
  return minutes;
}

/** Run a delivery create; a blank `--agreement` learns that omitting it is how to start without one. */
async function withCreateHint<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const refusal = blankProse('agreement');
    if (error instanceof MimirError && error.message === refusal.message) {
      throw new MimirError(refusal.code, refusal.message, 'omit --agreement to create without one');
    }
    throw error;
  }
}

/** A delivery and how the styled views render it. */
type DeliveryValue = { delivery: DeliveryView; presentation: Presentation };
/** The deliveries read and how the styled views render them. */
type DeliveriesValue = { deliveries: DeliveryView[]; presentation: Presentation };

const views = recordViews<DeliveryValue>({
  ids: (v) => v.delivery.id,
  json: (v) => v.delivery,
  records: (v) => renderDelivery(v.delivery, v.presentation),
});
const listViews = recordViews<DeliveriesValue>({
  ids: (v) => v.deliveries.map((d) => d.id).join('\n'),
  json: (v) => ({ deliveries: v.deliveries, total: v.deliveries.length }),
  jsonl: (v) => v.deliveries,
  records: (v) =>
    v.deliveries.length
      ? v.deliveries.map((d) => renderDelivery(d, v.presentation)).join('\n\n')
      : 'No deliveries.',
});
export function createDeliveryCommand(ports: Ports) {
  return new Command('delivery', {
    description: 'Create an attempt to deliver a phase.',
    extensions: [
      helpCommand({
        examples: [
          {
            command: 'create delivery "Ship the phase" --phase MMR-2',
            note: 'record an agreed attempt',
          },
          {
            command: 'create delivery --phase MMR-2 -- "--weird title"',
            note: 'a title that starts with a dash',
          },
        ],
      }),
      mcpCommand({ annotations: writeHints }),
    ],
  })
    .argument('title', { description: 'The delivery title.' })
    .option('phase', { ...text('The phase this attempt delivers.'), required: true })
    .option('agreement', text('The whole delivery agreement.'))
    .option('ref', text('The milestone pull request.'))
    .option('branch', text('The integration branch.'))
    .option('host', text('The orchestrator host.'))
    .option('harness', text('The orchestrator harness.'))
    .option('session', text('The orchestrator session.'))
    .option('time-cap', text('A positive whole number of minutes.'))
    .option('ascii', asciiOption)
    .result<DeliveryValue>({ views })
    .views({ records: views.records }, { default: 'records' })
    .action(async ({ args, host, options, out, passthrough }) => {
      const title = requireTitle(args.title, passthrough, 'delivery');
      const timeCap = parseTimeCap(options['time-cap']);
      const engine = await ports.engine();
      const delivery = encodeDelivery(
        await withCreateHint(() =>
          engine.deliveryCreate({
            agreement: options.agreement,
            branch: options.branch,
            external_ref: options.ref,
            harness: options.harness,
            host: options.host,
            phase: options.phase,
            session: options.session,
            time_cap_minutes: timeCap,
            title,
          }),
        ),
      );
      await out.results({ delivery, presentation: presentationOf(host, options.ascii) });
    });
}
export function deliveriesCommand(ports: Ports) {
  return new Command('deliveries', {
    description: "Read one project's delivery records.",
    extensions: [
      helpCommand({
        examples: [{ command: 'deliveries --project MMR', note: 'read the project attempts' }],
      }),
      mcpCommand({ annotations: { openWorld: false, readOnly: true } }),
    ],
  })
    .option('project', { ...text('The project key; defaults to the clone binding.'), short: 'p' })
    .option('ascii', asciiOption)
    .result<DeliveriesValue>({ views: listViews })
    .views({ table: listViews.table }, { default: 'table' })
    .action(async ({ host, options, out }) => {
      const project = await boardProject(ports, options.project, 'deliveries', (line) => {
        void out.print(line);
      });
      const deliveries = (await (await ports.engine()).deliveries({ project })).map(encodeDelivery);
      await out.results({ deliveries, presentation: presentationOf(host, options.ascii) });
    });
}
