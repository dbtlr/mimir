/**
 * The record `get` reads, and the text of its views, which the writes that
 * echo an artifact or a seed print as well.
 */
import type { ArtifactDetail, NodeView, SeedView } from '@mimir/contract';

import { renderRecords, renderTable } from './node';
import type { Presentation } from './presentation';
import { renderArtifactRecords, renderArtifactTable, renderSeedRecords } from './records';

/** The record `get` read, with its wire object and how the styled views render it. */
export type GetValue = { presentation: Presentation; wire: Record<string, unknown> } & (
  | { kind: 'node'; node: NodeView; expandAnnotations: boolean }
  | { kind: 'artifact'; artifact: ArtifactDetail }
  | { kind: 'seed'; seed: SeedView }
);

/** The styled `records` text of a record `get` read. */
export function recordsOf(value: Readonly<GetValue>): string {
  if (value.kind === 'node') {
    return renderRecords(value.node, value.presentation, value.expandAnnotations);
  }
  if (value.kind === 'artifact') {
    return renderArtifactRecords(value.artifact, value.presentation);
  }
  return renderSeedRecords(value.seed, value.presentation);
}

/** A seed has no table of its own: its `table` is its record. */
export function tableOf(value: Readonly<GetValue>): string {
  if (value.kind === 'node') {
    const one = { items: [value.node], returned: 1, startsAt: 0, total: 1 };
    return renderTable(one, value.presentation, 'task');
  }
  if (value.kind === 'artifact') {
    return renderArtifactTable(value.artifact, value.presentation);
  }
  return renderSeedRecords(value.seed, value.presentation);
}

/** The id the `ids` view prints for a record. */
export function idOf(value: Readonly<GetValue>): string {
  if (value.kind === 'node') {
    return value.node.id;
  }
  return value.kind === 'artifact' ? value.artifact.id : value.seed.id;
}
