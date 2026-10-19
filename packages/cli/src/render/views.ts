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
