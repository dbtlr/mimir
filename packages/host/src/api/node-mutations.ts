import type { Grooming } from '@mimir/contract';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';

import type { TransitionVerb } from '../lib/transitions';
import { apiSend } from './client';
import { reasonBody, useInvalidateOnWrite } from './mutations';
import type { WireNode } from './types';

/* A node's writes: verbs, grooming, authoring, links, direction, notes, and tags. */

export type TransitionInput = {
  verb: TransitionVerb;
  reason?: string;
};

/**
 * Fire a lifecycle or hold verb. It stays pending until the refetches land, so
 * a button that disables on `isPending` stays off until its row has moved and
 * cannot send the verb twice.
 */
export function useTransition(id: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: ({ verb, reason }: TransitionInput) =>
      apiSend<WireNode>('POST', `/api/nodes/${encodeURIComponent(id)}/${verb}`, reasonBody(reason)),
    onError: (err: Error) => {
      toast.error(err.message);
    },
    onSettled: invalidate,
  });
}

export type GroomInput = {
  state: Grooming;
  /** The server requires one for `needs_answers` and writes it as an ordinary note. */
  note?: string;
};

/**
 * Set a task's grooming state (ADR 0033) through its own route, not the plain
 * update. It stays pending until the refetches land, so the dialog closes on
 * fresh data and cannot write the same note twice.
 */
export function useGroom(id: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: ({ state, note }: GroomInput) => {
      const trimmed = note?.trim() ?? '';
      return apiSend<WireNode>('POST', `/api/nodes/${encodeURIComponent(id)}/groom`, {
        state,
        ...(trimmed === '' ? {} : { note: trimmed }),
      });
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
    onSettled: invalidate,
  });
}

/**
 * One create for all three authorable node types (MMR-227) — the route
 * branches on `type` server-side. `open_ended` is container-only;
 * priority/size/external_ref are task-only. The server validates the split.
 */
export type CreateNodeInput = {
  type: 'task' | 'phase' | 'initiative';
  parent: string;
  title: string;
  description?: string;
  summary?: string;
  priority?: string;
  size?: string;
  external_ref?: string;
  open_ended?: boolean;
  tags?: string[];
};

export function useCreateNode() {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (input: CreateNodeInput) => apiSend<WireNode>('POST', '/api/nodes', input),
    onError: (err: Error) => toast.error(err.message),
    onSettled: () => void invalidate(),
  });
}

/**
 * Dependencies are applied after the node exists (`POST /api/nodes` takes no
 * deps field), so create-with-deps is create-then-depend — two writes, not
 * one. The id is only known at mutate time (the reorder pattern).
 */
export type DependInput = {
  id: string;
  on: string[];
};

export type UseDependOptions = {
  /**
   * MMR-273: the hook owns the raw-cause toast by default (create mode's
   * single-write failures have no other narrator). A caller that folds the
   * outcome into its own message — e.g. promote's honest partial-failure
   * recap, which already names the spawned task — passes `silent: true` so
   * only its toast fires. One owner per flow, never both.
   */
  silent?: boolean;
};

export function useDepend(options?: UseDependOptions) {
  const invalidate = useInvalidateOnWrite();
  const silent = options?.silent === true;
  return useMutation({
    mutationFn: ({ id, on }: DependInput) =>
      apiSend<WireNode>('POST', `/api/nodes/${encodeURIComponent(id)}/depend`, { on }),
    onError: silent ? undefined : (err: Error) => toast.error(err.message),
    onSettled: () => void invalidate(),
  });
}

/** The symmetric un-link, for edit-surface reuse. */
export function useUndepend() {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: ({ id, on }: DependInput) =>
      apiSend<WireNode>('POST', `/api/nodes/${encodeURIComponent(id)}/undepend`, { on }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: () => void invalidate(),
  });
}

export type UpdateNodeInput = {
  title?: string;
  description?: string;
  /** Owned direction prose (ADR 0026) — containers only; tasks never carry it. */
  next?: string;
  summary?: string;
  priority?: string;
  size?: string;
  external_ref?: string;
};

export function useUpdateNode(id: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (fields: UpdateNodeInput) =>
      apiSend<WireNode>('PATCH', `/api/nodes/${encodeURIComponent(id)}`, fields),
    onError: (err: Error) => toast.error(err.message),
    onSettled: () => void invalidate(),
  });
}

/**
 * Reparent a node (MMR-73). Distinct from {@link useUpdateNode}: moving is a
 * verb (`move_node`), not the dumb `update` — so the edit form's parent change
 * goes through here, not the PATCH.
 */
export function useMoveNode(id: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (to: string) =>
      apiSend<WireNode>('POST', `/api/nodes/${encodeURIComponent(id)}/move`, { to }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: () => void invalidate(),
  });
}

/**
 * What owns a direction (ADR 0026 Decision 2): a project addresses by key, an
 * initiative or phase by node id. Tasks never carry one.
 */
export type DirectionTarget = { kind: 'project'; key: string } | { kind: 'node'; id: string };

/** The PATCH route for a direction target — the two surfaces that accept `next`. */
function directionPath(target: DirectionTarget): string {
  return target.kind === 'project'
    ? `/api/projects/${encodeURIComponent(target.key)}`
    : `/api/nodes/${encodeURIComponent(target.id)}`;
}

/**
 * Write a subject's direction (MMR-390) — one PATCH for both routes, since
 * the body (`{ next }`) is the same either way. Unlike its siblings this one
 * AWAITS the invalidation from `onSettled`: the editor closes on the settled
 * mutation, so awaiting here is what keeps the reading pane from flashing the
 * prose the operator just replaced.
 */
export function useUpdateDirection(target: DirectionTarget) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (next: string) => apiSend<WireNode>('PATCH', directionPath(target), { next }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: invalidate,
  });
}

export function useAnnotate(id: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (content: string) =>
      apiSend<WireNode>('POST', `/api/nodes/${encodeURIComponent(id)}/annotations`, { content }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: () => void invalidate(),
  });
}

export function useTag(id: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (tag: string) =>
      apiSend<WireNode>(
        'PUT',
        `/api/nodes/${encodeURIComponent(id)}/tags/${encodeURIComponent(tag)}`,
        undefined,
      ),
    onError: (err: Error) => toast.error(err.message),
    onSettled: () => void invalidate(),
  });
}

export function useUntag(id: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (tag: string) =>
      apiSend<WireNode>(
        'DELETE',
        `/api/nodes/${encodeURIComponent(id)}/tags/${encodeURIComponent(tag)}`,
        undefined,
      ),
    onError: (err: Error) => toast.error(err.message),
    onSettled: () => void invalidate(),
  });
}
