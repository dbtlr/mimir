/**
 * Shared decoders for `NornClient` results (MMR-152). Both Norn read paths — the
 * artifact slice (`core/artifacts/norn.ts`) and the node/project slice
 * (`core/store-norn.ts`, plus the body-section and transitions readers) — decode
 * the same two shapes out of `vault.get`/`vault.find` records: frontmatter
 * values (a wikilink or string list) and a record's path/body. These lived as
 * byte-for-byte copies in each reader, so a future decode fix (e.g. `[[stem|alias]]`
 * display text, or a path convention change) could silently diverge them. One
 * home, one behavior.
 */

/** Collapse `[[STEM]]` (or a bare stem) to the stem text; null when unusable. */
export function collapse(link: unknown): string | null {
  if (typeof link !== 'string') {
    return null;
  }
  const inner = link.startsWith('[[') && link.endsWith(']]') ? link.slice(2, -2) : link;
  return inner === '' ? null : inner;
}

/** A frontmatter value narrowed to its string members — a non-array yields `[]`. */
export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** The document stem — the canonical id. `MMR/MMR-2.md` → `MMR-2`, `MMR/MMR.md` → `MMR`. */
export function stemOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.endsWith('.md') ? base.slice(0, -3) : base;
}

/** A `vault.get` record's `path` + `.body`; a non-string path drops the record,
 * an absent/non-string body reads as the empty string. */
export function pathAndBody(record: unknown): { path: string; body: string } | null {
  if (typeof record !== 'object' || record === null || !('path' in record)) {
    return null;
  }
  const path = (record as { path: unknown }).path;
  if (typeof path !== 'string') {
    return null;
  }
  const body = 'body' in record ? (record as { body: unknown }).body : '';
  return { body: typeof body === 'string' ? body : '', path };
}
