/**
 * The record `get` reads, and the text of its views, which the writes that
 * echo an artifact, a seed, or a delivery print as well.
 */
import type { ArtifactDetail, DecisionView, NodeView, SeedView } from '@mimir/contract';

import { renderDecision } from './decisions';
import { renderDelivery, renderDeliverySince } from './deliveries';
import type { DeliveryFeed, DeliveryShown } from './deliveries';
import { renderRecords, renderTable } from './node';
import type { Presentation } from './presentation';
import { renderArtifactRecords, renderArtifactTable, renderSeedRecords } from './records';

/** The record `get` read, with its wire object and how the styled views render it. */
export type GetValue = { presentation: Presentation; wire: Record<string, unknown> } & (
  | { kind: 'node'; node: NodeView; expandAnnotations: boolean; expandItems: boolean }
  | { kind: 'artifact'; artifact: ArtifactDetail }
  | { kind: 'seed'; seed: SeedView }
  | { kind: 'decision'; decision: DecisionView }
  | { kind: 'delivery'; delivery: DeliveryShown; feed?: DeliveryFeed }
);

/** A delivery read as `get` prints it, then its change feed when `--since` asked for one. */
function deliveryText(value: Extract<GetValue, { kind: 'delivery' }>): string {
  return value.feed === undefined
    ? renderDelivery(value.delivery, value.presentation)
    : renderDeliverySince(value.delivery, value.feed, value.presentation);
}

/** The styled `records` text of a record `get` read. */
export function recordsOf(value: Readonly<GetValue>): string {
  if (value.kind === 'decision') {
    return renderDecision(value.decision, value.presentation);
  }
  if (value.kind === 'delivery') {
    return deliveryText(value);
  }
  if (value.kind === 'node') {
    return renderRecords(
      value.node,
      value.presentation,
      value.expandAnnotations,
      value.expandItems,
    );
  }
  if (value.kind === 'artifact') {
    return renderArtifactRecords(value.artifact, value.presentation);
  }
  return renderSeedRecords(value.seed, value.presentation);
}

/** A seed has no table of its own: its `table` is its record. */
export function tableOf(value: Readonly<GetValue>): string {
  if (value.kind === 'decision') {
    return renderDecision(value.decision, value.presentation);
  }
  if (value.kind === 'delivery') {
    return deliveryText(value);
  }
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
  if (value.kind === 'decision') {
    return value.decision.id;
  }
  if (value.kind === 'delivery') {
    return value.delivery.id;
  }
  if (value.kind === 'node') {
    return value.node.id;
  }
  return value.kind === 'artifact' ? value.artifact.id : value.seed.id;
}
