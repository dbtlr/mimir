/**
 * What an editor sends for long prose (a description or a direction): the text
 * as typed, or `null` when it is empty or only whitespace. The Engine refuses
 * blank text because Mimir keeps no earlier version, so saving an emptied
 * editor is the person's explicit clear, spelled `null`.
 */
export function proseOrNull(text: string): string | null {
  return text.trim() === '' ? null : text;
}
