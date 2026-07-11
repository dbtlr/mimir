/**
 * Suggest a project KEY from a title (MMR-230): uppercase word initials,
 * falling back to the leading consonants of a single word, clamped to at most
 * four A–Z characters. This is a client-side *suggestion* only — the field
 * stays editable until create, and the server owns uniqueness/validity.
 */
export function suggestKey(title: string): string {
  const words = title.toUpperCase().match(/[A-Z]+/g) ?? [];
  const initials = words.map((w) => w.slice(0, 1)).join('');
  if (initials.length >= 2) {
    return initials.slice(0, 4);
  }
  // Single word (or none): its first letter, then its consonants.
  const word = words.join('');
  if (word === '') {
    return '';
  }
  const squeezed = word.slice(0, 1) + word.slice(1).replaceAll(/[AEIOU]/g, '');
  return squeezed.slice(0, 3);
}
