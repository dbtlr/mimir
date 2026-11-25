/** A comma list's distinct, non-empty values, in order, as the list URLs spell them. */
export function csv(value: string | undefined): string[] {
  const seen: string[] = [];
  for (const token of (value ?? '').split(',').map((t) => t.trim())) {
    if (token !== '' && !seen.includes(token)) {
      seen.push(token);
    }
  }
  return seen;
}
