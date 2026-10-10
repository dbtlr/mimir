/**
 * Record URLs (ADR 0013, v0.23 refinement): a record's path is its ID split at
 * the hyphen, under its project — `MMR-417` lives at `/p/MMR/417`. The
 * translation is mechanical in both directions, so no lookup is ever needed.
 */

const KEY = /^[A-Z]{2,4}$/;
const NODE_SUFFIX = /^\d+$/;
const BARE_NODE = /^([A-Z]{2,4})-(\d+)$/;

/** Router target for a work node's page: `nodeLink('MMR-417')` → `/p/MMR/417`. */
export function nodeLink(id: string) {
  const dash = id.indexOf('-');
  return {
    params: { key: id.slice(0, dash), seq: id.slice(dash + 1) },
    to: '/p/$key/$seq' as const,
  };
}

/** The node id a record path names, or undefined when the suffix is not a node's. */
export function nodeIdOf(key: string, suffix: string): string | undefined {
  const upper = key.toUpperCase();
  return KEY.test(upper) && NODE_SUFFIX.test(suffix) ? `${upper}-${suffix}` : undefined;
}

/**
 * Where an unmatched path that is a bare ID or project key goes, judged by
 * grammar alone and in any case: `/mmr-417` → `/p/MMR/417`, `/MMR` → `/p/MMR`.
 * The record page owns the not-found state when no such record exists.
 */
export function bareIdRedirect(segment: string) {
  const upper = segment.toUpperCase();
  if (KEY.test(upper)) {
    return { params: { key: upper }, to: '/p/$key' as const };
  }
  return BARE_NODE.test(upper) ? nodeLink(upper) : undefined;
}
