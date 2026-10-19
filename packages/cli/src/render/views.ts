/**
 * Helpers that turn rendered text into Loom views. Every view escapes its text
 * from Loom's markup, because the text is data. A view keeps the old CLI's
 * newline rule: one newline, unless the text already ends with one.
 */
import type { View, ViewContext } from '@loomcli/core';

/** `text` with the one trailing newline the old CLI's writer added. */
export function withNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

/** DEL and the C1 controls as `\uXXXX`, as Loom's own JSON views write them, so none reaches a terminal. */
function escapeControls(text: string): string {
  return text.replaceAll(
    /[\u007F-\u009F]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** A view over text: styled text keeps raw SGR codes, which Loom's rendering policy governs. */
export function textView<Data>(text: (data: Readonly<Data>) => string): View<Data> {
  return { render: (data, context: ViewContext) => context.style.escape(withNewline(text(data))) };
}

/** A view over JSON text that declares its media type, so a failure prints as JSON too. */
export function jsonView<Data>(
  mediaType: 'application/json' | 'application/jsonl',
  text: (data: Readonly<Data>) => string,
): View<Data> {
  return {
    mediaType,
    render: (data, context: ViewContext) =>
      escapeControls(context.style.escape(withNewline(text(data)))),
  };
}

/** `value` as the indented JSON document `json` prints. */
export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** `value` as the one-line JSON a `jsonl` row prints. */
export function compactJson(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * What each view prints, as text. `jsonl` defaults to `json`, and `table` to
 * `records`. A command with no `ids` view leaves it out, and the formatter
 * refuses the format.
 */
export type RecordViewSpec<Data> = {
  json: (data: Readonly<Data>) => string;
  jsonl?: (data: Readonly<Data>) => string;
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
  // The key order is the order help lists the formats in.
  return {
    ...(spec.ids === undefined ? {} : { ids: textView(spec.ids) }),
    json: jsonView('application/json', spec.json),
    jsonl: jsonView('application/jsonl', spec.jsonl ?? spec.json),
    records: textView(spec.records),
    ...(spec.table === false ? {} : { table: textView(spec.table ?? spec.records) }),
  };
}
