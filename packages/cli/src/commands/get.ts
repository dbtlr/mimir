/**
 * `get <id>`: one full record, routed by the id's grammar to the Engine's
 * node, artifact, or seed read.
 */
import { Command } from '@loomcli/core';
import { helpCommand } from '@loomcli/plugins/help/extension';
import { mcpCommand } from '@loomcli/plugins/mcp/extension';
import { CHEAP_FACETS, intentEncoders } from '@mimir/contract';
import type { ArtifactDetail, NodeView, SeedView } from '@mimir/contract';

import { asciiOption, colOption } from '../options';
import { parseFacets } from '../parse';
import type { Ports } from '../ports';
import { renderRecords, renderTable } from '../render/node';
import { presentationOf } from '../render/presentation';
import type { Presentation } from '../render/presentation';
import { renderArtifactRecords, renderArtifactTable, renderSeedRecords } from '../render/records';
import { jsonView, textView } from '../render/views';

/** The record `get` read, with its wire object and how the styled views render it. */
export type GetValue = { presentation: Presentation; wire: Record<string, unknown> } & (
  | { kind: 'node'; node: NodeView; expandAnnotations: boolean }
  | { kind: 'artifact'; artifact: ArtifactDetail }
  | { kind: 'seed'; seed: SeedView }
);

function recordsOf(value: Readonly<GetValue>): string {
  if (value.kind === 'node') {
    return renderRecords(value.node, value.presentation, value.expandAnnotations);
  }
  if (value.kind === 'artifact') {
    return renderArtifactRecords(value.artifact, value.presentation);
  }
  return renderSeedRecords(value.seed, value.presentation);
}

/** A seed has no table of its own: its `table` is its record. */
function tableOf(value: Readonly<GetValue>): string {
  if (value.kind === 'node') {
    const one = { items: [value.node], returned: 1, startsAt: 0, total: 1 };
    return renderTable(one, value.presentation, 'task');
  }
  if (value.kind === 'artifact') {
    return renderArtifactTable(value.artifact, value.presentation);
  }
  return renderSeedRecords(value.seed, value.presentation);
}

function idOf(value: Readonly<GetValue>): string {
  if (value.kind === 'node') {
    return value.node.id;
  }
  return value.kind === 'artifact' ? value.artifact.id : value.seed.id;
}

const pretty = (value: Readonly<GetValue>): string => JSON.stringify(value.wire, null, 2);

/** `jsonl` of one record prints the same indented document as `json`, as the old CLI did. */
const views = {
  ids: textView(idOf),
  json: jsonView('application/json', pretty),
  jsonl: jsonView('application/jsonl', pretty),
  records: textView(recordsOf),
  table: textView(tableOf),
};

/** Read the record `id` names. Only the Engine reads work state. */
async function readRecord(
  ports: Ports,
  id: string,
  cols: readonly string[],
  presentation: Presentation,
): Promise<GetValue> {
  const kind = ports.grammar.idKind(id);
  if (kind === 'artifact') {
    const engine = await ports.engine();
    const artifact = intentEncoders.artifactDetail.parse(
      await engine.getArtifact({ content: cols.includes('content'), id }),
    );
    return { artifact, kind, presentation, wire: ports.wire.artifact(artifact) };
  }
  if (kind === 'seed') {
    // A seed's detail read carries its description, as on every transport.
    const engine = await ports.engine();
    const seed = intentEncoders.seed.parse(await engine.getSeed({ content: true, id }));
    return { kind, presentation, seed, wire: ports.wire.seed(seed) };
  }
  // Parsed before the store opens: a wrong invocation never opens it.
  const facets = parseFacets(cols, 'get');
  const engine = await ports.engine();
  const node = intentEncoders.node.parse(
    await engine.getNode({
      facets: facets.length > 0 ? [...new Set([...CHEAP_FACETS, ...facets])] : undefined,
      id,
    }),
  );
  // `annotations` is always read, so only the raw `--col` list says to expand it.
  const expandAnnotations = facets.includes('annotations');
  return { expandAnnotations, kind: 'node', node, presentation, wire: ports.wire.node(node) };
}

export function getCommand(ports: Ports) {
  return new Command('get', {
    description:
      'Read one full record: a task, phase, or initiative (KEY-seq), a project (KEY), an artifact (KEY-aN), or a seed (KEY-sN).',
    extensions: [
      helpCommand({
        examples: [
          { command: 'get MMR-16', note: 'the full record, cheap facets included' },
          { command: 'get MMR-16 --col history', note: 'add the transition log' },
          { command: 'get MMR-16 --col annotations', note: 'expand annotation bodies' },
          { command: 'get MMR-a1 --col content', note: "an artifact's frozen body" },
          { command: 'get MMR-s1', note: 'a seed, with its description' },
        ],
      }),
      mcpCommand({ annotations: { openWorld: false, readOnly: true } }),
    ],
  })
    .argument('id', {
      description: 'KEY-seq, KEY, KEY-aN, or KEY-sN.',
      required: true,
    })
    .option('col', colOption)
    .option('ascii', asciiOption)
    .result<GetValue>({ views })
    .views({}, { default: 'records' })
    .action(async ({ args, host, options, out }) => {
      const presentation = presentationOf(host, options.ascii);
      await out.results(await readRecord(ports, args.id, options.col, presentation));
    });
}
