/**
 * Shared pieces of the machine-local commands' views: the views that print
 * prose under every styled format (these commands have no table or ids of
 * their own).
 */
import type { View } from '@loomcli/core';

import { recordViews } from './views';

/** `view`, but printing nothing at all for empty text, as the old CLI wrote no line. */
function silentWhenEmpty<Value>(
  view: View<Value>,
  text: (value: Readonly<Value>) => string,
): View<Value> {
  return { render: (value, context) => (text(value) === '' ? '' : view.render(value, context)) };
}

/**
 * The five views of a result that prints `text` as prose under `ids`,
 * `records`, and `table`, and `json` as one document. `jsonl` repeats `json`
 * unless it is given its own text. Empty prose prints nothing at all.
 */
export function proseViews<Value>(
  text: (value: Readonly<Value>) => string,
  json: (value: Readonly<Value>) => string,
  jsonl: (value: Readonly<Value>) => string = json,
): Record<'ids' | 'json' | 'jsonl' | 'records' | 'table', View<Value>> {
  const views = recordViews({ ids: text, json, jsonl, records: text, table: text });
  return {
    ...views,
    ids: silentWhenEmpty(views.ids, text),
    records: silentWhenEmpty(views.records, text),
    table: silentWhenEmpty(views.table, text),
  };
}
