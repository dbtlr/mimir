/**
 * An artifact's kind (MMR-229, MMR-725): a read-side convention over its tags,
 * not a wire field (ADR 0005 grouping-by-tags). A `kind:` tag names it first;
 * failing that, the first of a fixed list of bare tags does. Every other tag
 * stays a plain tag, so `workspace_unconsolidated` is never a kind.
 */

/** The tag namespace that names an artifact's kind. */
const KIND_PREFIX = 'kind:';

/** The bare tags that name a kind, in the order the Filter sheet offers them. */
const BARE_KIND_TAGS: readonly string[] = [
  'session_summary',
  'spec',
  'plan',
  'mock',
  'investigation',
  'report',
  'spike',
  'audit',
  'verification',
];

const isPrefixedKind = (tag: string) =>
  tag.startsWith(KIND_PREFIX) && tag.length > KIND_PREFIX.length;

/** What a tag says about its kind: the kind, or undefined for a plain tag. */
export function kindTagLabel(tag: string): string | undefined {
  if (isPrefixedKind(tag)) {
    return tag.slice(KIND_PREFIX.length);
  }
  return BARE_KIND_TAGS.includes(tag) ? tag : undefined;
}

/**
 * An artifact's kind and the tags left once the tag naming it is lifted out.
 * A second `kind:` tag, or a bare kind tag after the one read, stays a tag.
 */
export function splitKindTags(tags: readonly string[]): {
  kind: string | undefined;
  rest: string[];
} {
  const kindTag = tags.find(isPrefixedKind) ?? tags.find((tag) => BARE_KIND_TAGS.includes(tag));
  return {
    kind: kindTag === undefined ? undefined : kindTagLabel(kindTag),
    rest: tags.filter((tag) => tag !== kindTag),
  };
}

/** A kind as a word in sentence case: `session_summary` reads "Session summary". */
export function kindName(kind: string): string {
  const words = kind.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The Filter sheet's Kind options, one per kind: the fixed kinds in order, then
 * any `kind:` tag the loaded rows show, then the one the URL chose, so a linked
 * kind always has its pill. `tag` is what the `tag` filter takes; `label` names
 * the kind. The read takes one tag, so a kind filters by one spelling: the
 * URL's, else the rows' `kind:` tag, else the bare tag.
 */
export function kindTagOptions(
  rowTags: readonly (readonly string[])[],
  chosen: string | undefined,
): { tag: string; label: string }[] {
  const tagByKind = new Map<string, string>(BARE_KIND_TAGS.map((tag) => [tag, tag]));
  for (const tag of [...rowTags.flat(), ...(chosen === undefined ? [] : [chosen])]) {
    const kind = kindTagLabel(tag);
    if (kind !== undefined && (isPrefixedKind(tag) || tag === chosen)) {
      tagByKind.set(kind, tag);
    }
  }
  return [...tagByKind].map(([kind, tag]) => ({ label: kindName(kind), tag }));
}
