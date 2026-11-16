/**
 * `get <id>`: one full record, routed by the id's grammar to the Engine's
 * node, artifact, seed, or delivery read.
 */
import { Command } from '@loomcli/core';
import { helpCommand } from '@loomcli/plugins/help/extension';
import { mcpCommand } from '@loomcli/plugins/mcp/extension';
import {
  encodeDecision,
  CHEAP_FACETS,
  encodeDelivery,
  encodeDeliverySince,
  intentEncoders,
} from '@mimir/contract';

import { MimirUsageError } from '../failures';
import { DATE_QUERY_VERBS } from '../flag-owners';
import { asciiOption, colOption, text } from '../options';
import { parseFacets, parseSince } from '../parse';
import type { Ports } from '../ports';
import { idOf, recordsOf, tableOf } from '../render/get';
import type { GetValue } from '../render/get';
import { presentationOf } from '../render/presentation';
import type { Presentation } from '../render/presentation';
import { recordViews } from '../render/views';

/** `jsonl` of one record prints the same indented document as `json`, as the old CLI did. */
const views = recordViews<GetValue>({
  ids: idOf,
  json: (value) => value.wire,
  records: recordsOf,
  table: tableOf,
});

/** Whether `--col` names `content`, comma-separated or repeated. */
const wantsContent = (cols: readonly string[]): boolean =>
  cols.some((c) => c.split(',').some((part) => part.trim() === 'content'));

/**
 * The `--since` cursor, checked before the store opens: only a delivery id
 * takes one, and the value must be a zoned instant (ADR 0042, MMR-692).
 */
function sinceOf(ports: Ports, id: string, since: string | undefined): Date | undefined {
  if (since === undefined) {
    return undefined;
  }
  if (ports.grammar.idKind(id) !== 'delivery') {
    throw new MimirUsageError(
      "--since reads a delivery's change feed, so it takes only a delivery id (KEY-dN)",
      `to window a list by date, use --at-or-after with ${DATE_QUERY_VERBS.slice(0, -1).join(', ')}, or ${DATE_QUERY_VERBS.at(-1) ?? ''}`,
    );
  }
  return parseSince(ports.grammar, since);
}

/** Read the record `id` names. Only the Engine reads work state. */
async function readRecord(
  ports: Ports,
  id: string,
  cols: readonly string[],
  presentation: Presentation,
  since?: Date,
): Promise<GetValue> {
  const kind = ports.grammar.idKind(id);
  if (kind === 'decision') {
    const result = await (await ports.engine()).getDecision({ id });
    const decision = encodeDecision(result);
    return { decision, kind, presentation, wire: { ...decision } };
  }
  if (kind === 'delivery' && since !== undefined) {
    // The since read: the delivery as `get` reads it, then the events after the cursor.
    const read = encodeDeliverySince(await (await ports.engine()).deliverySince({ id, since }));
    const { delivery, ...feed } = read;
    return { delivery, feed, kind, presentation, wire: { ...read } };
  }
  if (kind === 'delivery') {
    // A delivery's detail read carries its whole history, as a seed's carries
    // its description, on every transport and whatever `--col` names.
    const delivery = encodeDelivery(await (await ports.engine()).getDelivery({ id }));
    return { delivery, kind, presentation, wire: { ...delivery } };
  }
  if (kind === 'artifact') {
    const engine = await ports.engine();
    const artifact = intentEncoders.artifactDetail.parse(
      await engine.getArtifact({ content: wantsContent(cols), id }),
    );
    return { artifact, kind, presentation, wire: ports.wire.artifact(artifact) };
  }
  if (kind === 'seed') {
    // A seed's detail read carries its description, as on every transport.
    const engine = await ports.engine();
    const seed = intentEncoders.seed.parse(await engine.getSeed({ content: true, id }));
    return { kind, presentation, seed, wire: ports.wire.seed(seed) };
  }
  // `items` is no Engine facet: a task's `get` always carries its checklist, and
  // the column only expands the records line. It is read off the list before the
  // facet parser, which would refuse it.
  const columns = cols.flatMap((col) => col.split(',').map((one) => one.trim()));
  const expandItems = columns.includes('items');
  // Parsed before the store opens: a wrong invocation never opens it.
  const facets = parseFacets(
    columns.filter((col) => col !== 'items'),
    'get',
  );
  const engine = await ports.engine();
  const node = intentEncoders.node.parse(
    await engine.getNode({
      facets: facets.length > 0 ? [...new Set([...CHEAP_FACETS, ...facets])] : undefined,
      id,
    }),
  );
  // `annotations` is always read, so only the raw `--col` list says to expand it.
  const expandAnnotations = facets.includes('annotations');
  return {
    expandAnnotations,
    expandItems,
    kind: 'node',
    node,
    presentation,
    wire: ports.wire.node(node),
  };
}

export function getCommand(ports: Ports) {
  return new Command('get', {
    description:
      'Read one full record: a task, phase, or initiative (KEY-seq), a project (KEY), an artifact (KEY-aN), a seed (KEY-sN), a delivery (KEY-dN), or a decision (KEY-qN).',
    extensions: [
      helpCommand({
        examples: [
          { command: 'get MMR-16', note: 'the full record, cheap facets included' },
          { command: 'get MMR-16 --col history', note: 'add the transition log' },
          { command: 'get MMR-16 --col annotations', note: 'expand annotation bodies' },
          { command: 'get MMR-a1 --col content', note: "an artifact's frozen body" },
          { command: 'get MMR-s1', note: 'a seed, with its description' },
          { command: 'get MMR-d1', note: 'a delivery, with its history' },
          {
            command: 'get MMR-d1 --since 2026-11-16T09:00:00Z',
            note: "a delivery's changes after that instant, with the cursor for the next read",
          },
        ],
      }),
      mcpCommand({ annotations: { openWorld: false, readOnly: true } }),
    ],
  })
    .argument('id', {
      description: 'KEY-seq, KEY, KEY-aN, KEY-sN, KEY-dN, or KEY-qN.',
      required: true,
    })
    .option('col', colOption)
    .option(
      'since',
      text(
        "A delivery's change feed: events after this zoned instant (KEY-dN only). Pass the answer's as_of next time.",
        'INSTANT',
      ),
    )
    .option('ascii', asciiOption)
    .result<GetValue>({ views })
    .views({ records: views.records }, { default: 'records' })
    .action(async ({ args, host, options, out }) => {
      const presentation = presentationOf(host, options.ascii);
      const since = sinceOf(ports, args.id, options.since);
      await out.results(await readRecord(ports, args.id, options.col, presentation, since));
    });
}
