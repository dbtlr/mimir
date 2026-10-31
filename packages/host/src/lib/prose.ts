const isBlank = (text: string | null | undefined): boolean => text == null || text.trim() === '';

/**
 * What an editor sends for long prose (a description or a direction), given
 * the text now in the editor and the text it started from: the text as typed,
 * `null` when the person emptied text that existed, and `undefined` (leave it)
 * when it was blank before and still is. The Engine refuses blank text because
 * Mimir keeps no earlier version, so emptying an editor is the person's
 * explicit clear, spelled `null`.
 */
export function proseEdit(
  text: string | null | undefined,
  before: string | null | undefined,
): string | null | undefined {
  if (!isBlank(text)) {
    return text;
  }
  return isBlank(before) ? undefined : null;
}
