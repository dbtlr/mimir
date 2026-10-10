import type { WireAnnotation, WireHistoryEntry } from '../api/types';

/** One merged timeline entry — the node's birth, a transition, or an annotation. */
export type FeedItem =
  | { variant: 'created'; at: string; sort: number }
  | { variant: 'transition'; at: string; sort: number; entry: WireHistoryEntry }
  | { variant: 'annotation'; at: string; sort: number; content: string };

/** Merge transitions + annotations + the creation anchor into one oldest-first feed. */
export function buildFeed(
  createdAt: string,
  history: readonly WireHistoryEntry[] | undefined,
  annotations: readonly WireAnnotation[] | undefined,
): FeedItem[] {
  const items: FeedItem[] = [{ at: createdAt, sort: Date.parse(createdAt), variant: 'created' }];
  for (const e of history ?? []) {
    items.push({ at: e.at, entry: e, sort: Date.parse(e.at), variant: 'transition' });
  }
  for (const a of annotations ?? []) {
    items.push({
      at: a.created_at,
      content: a.content,
      sort: Date.parse(a.created_at),
      variant: 'annotation',
    });
  }
  return items.toSorted((a, b) => a.sort - b.sort);
}

/** Human label + optional detail for a transition_log entry (mirrors the verbs that wrote it). */
export function describeTransition(e: WireHistoryEntry): { label: string; detail?: string } {
  switch (e.kind) {
    case 'lifecycle': {
      if (e.to === 'under_review') {
        return { label: 'Submitted for review' };
      }
      if (e.from === 'under_review' && e.to === 'in_progress') {
        return { label: 'Changes requested' };
      }
      if (e.to === 'in_progress') {
        return { label: 'Started' };
      }
      if (e.to === 'done') {
        return { label: e.from === 'under_review' ? 'Approved' : 'Completed' };
      }
      if (e.to === 'abandoned') {
        return { label: 'Abandoned' };
      }
      return { label: `→ ${e.to ?? '?'}` };
    }
    case 'hold': {
      if (e.to === 'parked') {
        return { label: 'Parked' };
      }
      if (e.to === 'blocked') {
        return { label: 'Blocked' };
      }
      if (e.from === 'parked') {
        return { label: 'Resumed' };
      }
      if (e.from === 'blocked') {
        return { label: 'Unblocked' };
      }
      return { label: 'Resumed' };
    }
    case 'dependency': {
      return e.from === null
        ? { detail: e.to ?? undefined, label: 'Dependency added' }
        : { detail: e.from ?? undefined, label: 'Dependency removed' };
    }
    case 'move': {
      return { detail: `${e.from ?? '—'} → ${e.to ?? '—'}`, label: 'Reparented' };
    }
    default: {
      return { label: 'Unknown' };
    }
  }
}
