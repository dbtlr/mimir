import type { EngineNode } from '@mimir/contract';
import { parseJson } from '@mimir/helpers';
import { z } from 'zod';

/** One transition_log entry of a node's history. */
export type HistoryEntry = NonNullable<EngineNode['history']>[number];

/** One freeform note on a node. */
export type NodeAnnotation = NonNullable<EngineNode['annotations']>[number];

/** One merged timeline entry — the node's birth, a transition, or an annotation. */
export type FeedItem =
  | { variant: 'created'; at: Date; sort: number }
  | { variant: 'transition'; at: Date; sort: number; entry: HistoryEntry }
  | { variant: 'annotation'; at: Date; sort: number; content: string };

/** Merge transitions + annotations + the creation anchor into one oldest-first feed. */
export function buildFeed(
  createdAt: Date,
  history: readonly HistoryEntry[] | undefined,
  annotations: readonly NodeAnnotation[] | undefined,
): FeedItem[] {
  const items: FeedItem[] = [{ at: createdAt, sort: createdAt.getTime(), variant: 'created' }];
  for (const e of history ?? []) {
    items.push({ at: e.at, entry: e, sort: e.at.getTime(), variant: 'transition' });
  }
  for (const a of annotations ?? []) {
    items.push({
      at: a.createdAt,
      content: a.content,
      sort: a.createdAt.getTime(),
      variant: 'annotation',
    });
  }
  return items.toSorted((a, b) => a.sort - b.sort);
}

const identitySchema = z.object({
  harness: z.string().nullish(),
  session: z.string().nullish(),
  worker_harness: z.string().nullish(),
  worker_session: z.string().nullish(),
});

/** Identify the main conversation and whole-task worker in historical snapshots. */
export function sessionIdentity(handles: z.infer<typeof identitySchema>): string {
  const roles: string[] = [];
  if (handles.session != null) {
    roles.push(`Main ${handles.harness == null ? '' : `${handles.harness}/`}${handles.session}`);
  }
  if (handles.worker_session != null) {
    roles.push(
      `Worker ${handles.worker_harness == null ? '' : `${handles.worker_harness}/`}${handles.worker_session}`,
    );
  }
  return roles.join(' · ');
}

function assignmentDetail(snapshot: string | null): string {
  try {
    return sessionIdentity(parseJson(snapshot ?? '{}', identitySchema)) || 'Unassigned';
  } catch {
    return snapshot ?? 'Unassigned';
  }
}

/** Human label + optional detail for a transition_log entry (mirrors the verbs that wrote it). */
export function describeTransition(e: HistoryEntry): { label: string; detail?: string } {
  switch (e.kind) {
    case 'assignment': {
      return {
        detail: `${assignmentDetail(e.from)} → ${assignmentDetail(e.to)}`,
        label: 'Session assignment changed',
      };
    }
    case 'lifecycle': {
      if (e.to === 'queued') {
        return { label: 'Queued' };
      }
      if (e.from === 'queued' && e.to === 'todo') {
        return { label: 'Unqueued' };
      }
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
