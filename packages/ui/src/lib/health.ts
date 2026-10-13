/** `1 finding` / `N findings` — the count phrase every health surface shows. */
export function findingCount(n: number): string {
  return `${String(n)} ${n === 1 ? 'finding' : 'findings'}`;
}
