import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import type { ReorderArgs } from '../lib/reorder';
import type { TransitionVerb } from '../lib/transitions';
import { apiSend } from './client';
import type { WireNode, WireSeed } from './types';

/** Every read key a write can stale. Broad invalidation is fine — the server is loopback. */
const WRITE_KEYS: readonly (readonly string[])[] = [
  ['board'],
  ['node'],
  ['nodes'],
  ['projects'],
  ['project'],
  ['seeds'],
  ['tree'],
];

function useInvalidateOnWrite(): () => void {
  const qc = useQueryClient();
  return () => {
    for (const queryKey of WRITE_KEYS) {
      void qc.invalidateQueries({ queryKey });
    }
  };
}

/** park/block/abandon/return/reopen carry a trimmed reason; plain verbs send no body. */
function reasonBody(reason?: string): { reason: string } | undefined {
  const trimmed = reason?.trim();
  return trimmed !== undefined && trimmed !== '' ? { reason: trimmed } : undefined;
}

export type TransitionInput = {
  verb: TransitionVerb;
  reason?: string;
};

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

/** Reorder is board-level: the id isn't known until a drop, so it's given at mutate time. */
export type ReorderInput = {
  id: string;
} & ReorderArgs;

export function useReorder() {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: ({ id, ...args }: ReorderInput) =>
      apiSend<WireNode>('POST', `/api/nodes/${encodeURIComponent(id)}/reorder`, args),
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
    onSettled: invalidate,
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

export function useDepend() {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: ({ id, on }: DependInput) =>
      apiSend<WireNode>('POST', `/api/nodes/${encodeURIComponent(id)}/depend`, { on }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: invalidate,
  });
}

/** The symmetric un-link, for edit-surface reuse. */
export function useUndepend() {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: ({ id, on }: DependInput) =>
      apiSend<WireNode>('POST', `/api/nodes/${encodeURIComponent(id)}/undepend`, { on }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: invalidate,
  });
}

export type UpdateNodeInput = {
  title?: string;
  description?: string;
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
    onSettled: invalidate,
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
    onSettled: invalidate,
  });
}

export type CreateProjectInput = {
  key: string;
  name: string;
  description?: string;
};

/**
 * Create a project (MMR-230): `POST /api/projects`. The wire body takes
 * `name` + `key` (not `title`) — the sheet maps TITLE→name, KEY→key. The
 * server owns key uniqueness/validity; its rejection toasts verbatim.
 */
export function useCreateProject() {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (input: CreateProjectInput) => apiSend<WireNode>('POST', '/api/projects', input),
    onError: (err: Error) => toast.error(err.message),
    onSettled: invalidate,
  });
}

/**
 * Archive a project (ADR 0015): frozen and hidden, never deleted. There is no
 * confirm — the caller raises an undo toast whose Unarchive is the recovery.
 */
export function useArchiveProject(key: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: () =>
      apiSend<WireNode>('POST', `/api/projects/${encodeURIComponent(key)}/archive`, undefined),
    onError: (err: Error) => toast.error(err.message),
    onSettled: invalidate,
  });
}

export type UpdateProjectInput = {
  title?: string;
  description?: string;
};

export function useUpdateProject(key: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (fields: UpdateProjectInput) =>
      apiSend<WireNode>('PATCH', `/api/projects/${encodeURIComponent(key)}`, fields),
    onError: (err: Error) => toast.error(err.message),
    onSettled: invalidate,
  });
}

/**
 * Restore an archived project (ADR 0015, MMR-125) — fired from the shelf's
 * frozen card and the archive undo toast alike. Deliberately no confirmation
 * either way: unarchive IS the undo. Errors toast verbatim and the card stays
 * on the shelf (no optimistic removal — writes invalidate + refetch).
 */
export function useUnarchiveProject(key: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: () =>
      apiSend<WireNode>('POST', `/api/projects/${encodeURIComponent(key)}/unarchive`, undefined),
    onError: (err: Error) => toast.error(err.message),
    onSettled: invalidate,
  });
}

/**
 * File a seed (MMR-247) — `POST /api/seeds`. Console-filed seeds are self-filed:
 * `requester` is never sent (the server nulls it → "you"). `kind` defaults to
 * `idea` at the call site; `description` is optional (edited later in detail).
 */
export type FileSeedInput = {
  project: string;
  title: string;
  kind: string;
  description?: string;
};

export function useFileSeed() {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (input: FileSeedInput) => apiSend<WireSeed>('POST', '/api/seeds', input),
    onError: (err: Error) => toast.error(err.message),
    onSettled: invalidate,
  });
}

/**
 * Reject a seed (MMR-247) — `POST /api/seeds/:id/reject`. The server requires a
 * non-empty `reason`; the reason dialog gates confirm on it, so the body always
 * carries one.
 */
export function useRejectSeed(id: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (reason: string) =>
      apiSend<WireSeed>('POST', `/api/seeds/${encodeURIComponent(id)}/reject`, { reason }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: invalidate,
  });
}

/** Resolve a seed (MMR-247) — `POST /api/seeds/:id/resolve`, `reason` required (mirror of reject). */
export function useResolveSeed(id: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (reason: string) =>
      apiSend<WireSeed>('POST', `/api/seeds/${encodeURIComponent(id)}/resolve`, { reason }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: invalidate,
  });
}

export type UpdateSeedInput = {
  title?: string;
  kind?: string;
  description?: string;
};

/**
 * Patch a live seed (MMR-247) — `PATCH /api/seeds/:id`. The server refuses a
 * terminal (frozen) seed, so the detail surfaces edit only while the seed is
 * live; `requester`/`spawned` are verb-owned and never patched here.
 */
export function useUpdateSeed(id: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (fields: UpdateSeedInput) =>
      apiSend<WireSeed>('PATCH', `/api/seeds/${encodeURIComponent(id)}`, fields),
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
    onSettled: invalidate,
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
    onSettled: invalidate,
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
    onSettled: invalidate,
  });
}
