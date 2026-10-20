/**
 * The views a write prints. Most echo the record they wrote, under a one-line
 * note of what happened on the styled formats (`table`, `records`); the rest
 * (`create project`, `attach`, `tag`, `untag`, `groom`) print a small notice of
 * their own, as the old CLI did. `ids`, `json`, and `jsonl` carry no note.
 */
import { intentEncoders } from '@mimir/contract';
import type { NodeView } from '@mimir/contract';

import type { Ports } from '../ports';
import { renderRecords, renderTable } from './node';
import { okLine } from './presentation';
import type { Presentation } from './presentation';
import { compactJson, prettyJson, recordViews } from './views';

/** A written record, its note, and how the views render it. */
export type NodeEcho = {
  node: NodeView;
  /** The note above the styled views, already glyphed; absent for none. */
  note: string | undefined;
  presentation: Presentation;
  wire: Record<string, unknown>;
};

const withNote = (echo: Readonly<NodeEcho>, body: string): string =>
  echo.note === undefined ? body : `${echo.note}\n${body}`;

/** A written record's `records` text, under its note. */
export const nodeEchoRecords = (echo: Readonly<NodeEcho>): string =>
  withNote(echo, renderRecords(echo.node, echo.presentation));

/** A written record's `table` text, under its note. */
export const nodeEchoTable = (echo: Readonly<NodeEcho>): string =>
  withNote(
    echo,
    renderTable(
      { items: [echo.node], returned: 1, startsAt: 0, total: 1 },
      echo.presentation,
      'task',
    ),
  );

/** The views of a written record; the default is `records`. */
export const nodeEchoViews = recordViews<NodeEcho>({
  ids: (echo) => echo.node.id,
  json: (echo) => prettyJson(echo.wire),
  records: nodeEchoRecords,
  table: nodeEchoTable,
});

/**
 * The echo of an Engine write's node view. `note` words what happened from the
 * record's rendered id, and shows on the styled formats when given.
 */
export function nodeEcho(
  ports: Ports,
  written: unknown,
  presentation: Presentation,
  note?: (id: string) => string,
): NodeEcho {
  const node = intentEncoders.node.parse(written);
  return {
    node,
    note: note === undefined ? undefined : okLine(presentation, note(node.id)),
    presentation,
    wire: ports.wire.node(node),
  };
}

/** A write's own notice: its `ids` text, its JSON object, and its styled line. */
export type Notice = {
  /** What the `ids` view prints. */
  ids: string;
  /** The object `json` and `jsonl` print on one line. */
  json: Record<string, unknown>;
  /** What the styled views print. */
  line: string;
};

/** The views of a notice; the default is `records`. */
export const noticeViews = recordViews<Notice>({
  ids: (notice) => notice.ids,
  json: (notice) => compactJson(notice.json),
  records: (notice) => notice.line,
});
