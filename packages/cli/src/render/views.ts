/**
 * Helpers that build Loom views. A text view escapes its text from Loom's
 * markup, because the text is data, and keeps the old CLI's newline rule: one
 * newline, unless the text already ends with one. The JSON views are Loom's
 * own `json` and `jsonl` over a data projection, so encoding and control
 * escaping are Loom's; only text that is already a JSON document escapes its
 * own controls.
 */
import type { View, ViewContext } from '@loomcli/core';
import { json, jsonl } from '@loomcli/plugins/format';

/** `text` with the one trailing newline the old CLI's writer added. */
export function withNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

/** A view over text: styled text keeps raw SGR codes, which Loom's rendering policy governs. */
export function textView<Data>(text: (data: Readonly<Data>) => string): View<Data> {
  return { render: (data, context: ViewContext) => context.style.escape(withNewline(text(data))) };
}

/**
 * A view over text that is already a JSON document, such as the transfer
 * document, under any format. Loom's style resolution drops DEL and the C1
 * controls, and the characters a CSI or control-string start introduces, so
 * they print as `\uXXXX` escapes, as Loom's own JSON views write them. In JSON
 * they occur only inside strings, where the escape is the same character.
 */
export function documentView<Data>(text: (data: Readonly<Data>) => string): View<Data> {
  const view = textView(text);
  return {
    render: (data, context) =>
      view
        .render(data, context)
        .replaceAll(
          /[\u007F-\u009F]/gu,
          (control) => `\\u${control.charCodeAt(0).toString(16).padStart(4, '0')}`,
        ),
  };
}

type JsonMediaType = 'application/json' | 'application/jsonl';

/** `view` declared under `mediaType`: the old CLI printed one document under both `json` and `jsonl`. */
function declaredAs<Data>(view: View<Data>, mediaType: JsonMediaType): View<Data> {
  return { ...view, mediaType };
}

/** The document `map` projects, on one line. */
function compactView<Data>(
  map: (data: Readonly<Data>) => unknown,
  mediaType: JsonMediaType,
): View<Data> {
  // Wrapped, so a document that is itself an array still prints as one line.
  return declaredAs(jsonl<Data>({ map: (data) => [map(data)] }), mediaType);
}

/** One line per row `rows` projects. An empty list prints one empty line, as the old CLI did. */
function rowsView<Data>(rows: (data: Readonly<Data>) => readonly unknown[]): View<Data> {
  const view = jsonl<Data>({ map: rows });
  return {
    ...view,
    render: (data, context) => {
      const text = view.render(data, context);
      return text === '' ? '\n' : text;
    },
  };
}

/**
 * What a command's `json` and `jsonl` views print, as data. `json` is one
 * document, indented unless `compact`. `jsonl` repeats that document when
 * absent, prints it on one line for `'compact'`, or prints one line per row of
 * a projection.
 */
export type JsonViewSpec<Data> = {
  json: (data: Readonly<Data>) => unknown;
  compact?: true;
  jsonl?: 'compact' | ((data: Readonly<Data>) => readonly unknown[]);
};

/** The `json` and `jsonl` views a spec declares. */
function jsonViews<Data>(spec: JsonViewSpec<Data>): Record<'json' | 'jsonl', View<Data>> {
  const document =
    spec.compact === true
      ? compactView(spec.json, 'application/json')
      : json<Data>({ map: spec.json });
  if (spec.jsonl === undefined) {
    return { json: document, jsonl: declaredAs(document, 'application/jsonl') };
  }
  return {
    json: document,
    jsonl:
      spec.jsonl === 'compact' ? compactView(spec.json, 'application/jsonl') : rowsView(spec.jsonl),
  };
}

/**
 * What each view prints: `json` and `jsonl` as data (see {@link JsonViewSpec}),
 * the rest as text. `table` defaults to `records`. A command with no `ids`
 * view leaves it out, and the formatter refuses the format.
 */
export type RecordViewSpec<Data> = JsonViewSpec<Data> & {
  records: (data: Readonly<Data>) => string;
  /** `false` declares no `table` view, so the formatter refuses the format. */
  table?: ((data: Readonly<Data>) => string) | false;
};

/** The views every command with a record form declares. */
export type RecordViews<Data> = Record<'json' | 'jsonl' | 'records' | 'table', View<Data>>;

/** The one builder of a command's `ids`, `json`, `jsonl`, `records`, and `table` views. */
export function recordViews<Data>(
  spec: RecordViewSpec<Data> & { ids: (data: Readonly<Data>) => string },
): RecordViews<Data> & { ids: View<Data> };
export function recordViews<Data>(
  spec: RecordViewSpec<Data> & { ids?: undefined; table: false },
): Omit<RecordViews<Data>, 'table'>;
export function recordViews<Data>(
  spec: RecordViewSpec<Data> & { ids?: undefined },
): RecordViews<Data>;
export function recordViews<Data>(
  spec: RecordViewSpec<Data> & { ids?: (data: Readonly<Data>) => string },
): Partial<RecordViews<Data>> & { ids?: View<Data> } {
  const structured = jsonViews(spec);
  // The key order is the order help lists the formats in.
  return {
    ...(spec.ids === undefined ? {} : { ids: textView(spec.ids) }),
    json: structured.json,
    jsonl: structured.jsonl,
    records: textView(spec.records),
    ...(spec.table === false ? {} : { table: textView(spec.table ?? spec.records) }),
  };
}
