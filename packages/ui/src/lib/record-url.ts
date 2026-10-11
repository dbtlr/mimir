/**
 * Record URLs (ADR 0013, v0.23 refinement): a record's path is its ID split at
 * the hyphen, under its project — `MMR-417` lives at `/p/MMR/417`. The
 * translation is mechanical in both directions, so no lookup is ever needed.
 */

import type { SearchKind } from '@mimir/contract';

const KEY = /^[A-Z]{2,4}$/;
const NODE_SUFFIX = /^\d+$/;
const BARE_NODE = /^([A-Z]{2,4})-(\d+)$/;
const BARE_SEED = /^([A-Z]{2,4})-S(\d+)$/;

/** Router target for a work node's page: `nodeLink('MMR-417')` → `/p/MMR/417`. */
export function nodeLink(id: string) {
  const dash = id.indexOf('-');
  return {
    params: { key: id.slice(0, dash), seq: id.slice(dash + 1) },
    to: '/p/$key/$seq' as const,
  };
}

/** Router target for a seed's page: `seedLink('MMR-s41')` → `/p/MMR/s41`. */
export function seedLink(id: string) {
  const dash = id.indexOf('-');
  return {
    params: { key: id.slice(0, dash), seq: id.slice(dash + 2) },
    to: '/p/$key/s{$seq}' as const,
  };
}

/** A seed page's path as text, for copying and display: `/p/MMR/s41`. */
export function seedPath(id: string): string {
  const { params } = seedLink(id);
  return `/p/${params.key}/s${params.seq}`;
}

/**
 * Router target for any record's page, by kind. Artifacts open in their
 * browser until they get a page of their own (MMR-452).
 */
export function recordLink(record: { kind: SearchKind; id: string }) {
  switch (record.kind) {
    case 'project': {
      return { params: { key: record.id }, to: '/p/$key' as const };
    }
    case 'seed': {
      return seedLink(record.id);
    }
    case 'artifact': {
      return { search: { a: record.id }, to: '/artifacts' as const };
    }
    default: {
      return nodeLink(record.id);
    }
  }
}

/** The node id a record path names, or undefined when the suffix is not a node's. */
export function nodeIdOf(key: string, suffix: string): string | undefined {
  const upper = key.toUpperCase();
  return KEY.test(upper) && NODE_SUFFIX.test(suffix) ? `${upper}-${suffix}` : undefined;
}

/** The seed id a seed path names (`s41` arrives as `41`), or undefined off the grammar. */
export function seedIdOf(key: string, seq: string): string | undefined {
  const upper = key.toUpperCase();
  return KEY.test(upper) && NODE_SUFFIX.test(seq) ? `${upper}-s${seq}` : undefined;
}

/**
 * Where an unmatched path that is a bare ID or project key goes, judged by
 * grammar alone and in any case: `/mmr-417` → `/p/MMR/417`, `/mmr-s41` →
 * `/p/MMR/s41`, `/MMR` → `/p/MMR`.
 * The record page owns the not-found state when no such record exists.
 */
export function bareIdRedirect(segment: string) {
  const upper = segment.toUpperCase();
  if (KEY.test(upper)) {
    return { params: { key: upper }, to: '/p/$key' as const };
  }
  if (BARE_NODE.test(upper)) {
    return nodeLink(upper);
  }
  const seed = BARE_SEED.exec(upper);
  return seed === null ? undefined : seedLink(`${seed[1] ?? ''}-s${seed[2] ?? ''}`);
}
