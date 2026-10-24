/**
 * The result a node-set read (`next`, `list`, `projects`) hands Loom, and its
 * five views. `unit` names one row: the table's count line, and the `json`
 * envelope's key (`task` becomes `tasks`).
 */
import type { NodeView, SetResult } from '@mimir/contract';

import type { Ports } from '../ports';
import { renderRecords, renderTable } from './node';
import type { Presentation } from './presentation';
import { recordViews } from './views';

/** The set, its wire objects, and how the styled views render it. */
export type NodeSetValue = {
  result: SetResult<NodeView>;
  unit: string;
  /** The `json` envelope: `{ returned, starts_at, total, <unit>s }`. */
  wire: Record<string, unknown>;
  /** One wire object per node, for `jsonl`. */
  rows: Record<string, unknown>[];
  presentation: Presentation;
  /** What a terminal prints for an empty set. */
  emptyMessage: string;
};

/** Wrap an Engine set with its wire objects, ready for `out.results`. */
export function nodeSetValue(
  ports: Ports,
  result: SetResult<NodeView>,
  presentation: Presentation,
  unit: string,
  emptyMessage: string,
): NodeSetValue {
  return {
    emptyMessage,
    presentation,
    result,
    rows: result.items.map((node) => ports.wire.node(node)),
    unit,
    wire: ports.wire.set(result, `${unit}s`),
  };
}

function recordsOf(value: Readonly<NodeSetValue>): string {
  if (value.result.items.length === 0 && value.presentation.isTTY) {
    return value.emptyMessage;
  }
  return value.result.items.map((n) => renderRecords(n, value.presentation)).join('\n\n');
}

export const nodeSetViews = recordViews<NodeSetValue>({
  ids: (value) => value.result.items.map((n) => n.id).join('\n'),
  json: (value) => value.wire,
  jsonl: (value) => value.rows,
  records: recordsOf,
  table: (value) => renderTable(value.result, value.presentation, value.unit, value.emptyMessage),
});
