/**
 * Suggest a project KEY from a title (MMR-230): uppercase word initials,
 * falling back to the leading consonants of a single word, clamped to 2–4
 * A–Z characters — or empty when the title can't yield two letters. This is
 * a client-side *suggestion* only — the field stays editable until create,
 * and the server owns uniqueness/validity.
 */
export function suggestKey(title: string): string {
  const words = title.toUpperCase().match(/[A-Z]+/g) ?? [];
  const initials = words.map((w) => w.slice(0, 1)).join('');
  if (initials.length >= 2) {
    return initials.slice(0, 4);
  }
  // Single word (or none): its first letter, then its consonants.
  const word = words.join('');
  const squeezed = word.slice(0, 1) + word.slice(1).replaceAll(/[AEIOU]/g, '');
  if (squeezed.length >= 2) {
    return squeezed.slice(0, 3);
  }
  // All-vowel word ("AI", "Aeiou"): its leading letters. A one-letter word
  // can't reach the 2-char floor — suggest nothing and let the user type.
  return word.length >= 2 ? word.slice(0, 2) : '';
}
