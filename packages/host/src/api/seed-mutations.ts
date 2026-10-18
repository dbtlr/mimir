import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';

import { apiSend } from './client';
import { reasonBody, useInvalidateOnWrite } from './mutations';
import type { WireSeed } from './types';

/* A seed's writes: filing, triage verbs, promotion, and edits. */

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
    onSettled: () => void invalidate(),
  });
}

/*
 * The seed triage verbs stay pending until the refetches land, as a task's
 * transition does: a seed row on the review page leaves while its verb is
 * still pending, so keyboard focus can follow it (MMR-479), and its chips stay
 * off until then, so a verb cannot be sent twice.
 */

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

/** Park a seed (MMR-473) — `POST /api/seeds/:id/park`; the reason is optional, as on a task park. */
export function useParkSeed(id: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (reason?: string) =>
      apiSend<WireSeed>('POST', `/api/seeds/${encodeURIComponent(id)}/park`, reasonBody(reason)),
    onError: (err: Error) => toast.error(err.message),
    onSettled: invalidate,
  });
}

/** Unpark a seed (MMR-473) — `POST /api/seeds/:id/unpark`, back to the untriaged queue. */
export function useUnparkSeed(id: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: () => apiSend<WireSeed>('POST', `/api/seeds/${encodeURIComponent(id)}/unpark`),
    onError: (err: Error) => toast.error(err.message),
    onSettled: invalidate,
  });
}

/**
 * Promote a seed into work (MMR-248) — `POST /api/seeds/:id/promote`, create
 * mode: `parent` is the chosen home, title/description ride as edited, and
 * priority/size/tags when the sheet collected them. The echo is the seed wire
 * plus a SIBLING `created` field (the spawned task id), so the result widens
 * `WireSeed` with it. `['seeds']` and the node keys both invalidate (the task
 * is a new node), so the queue re-groups the seed to PROMOTED and the boards
 * pick up the spawned task.
 */
export type PromoteSeedInput = {
  parent: string;
  title?: string;
  description?: string;
  priority?: string;
  size?: string;
  tags?: string[];
};

/** The promote echo (MMR-245): the seed wire with the spawned task id as a sibling. */
export type PromotedSeed = WireSeed & { created?: string };

/** A seed's promote, so a surface can ask whether one is still in flight. */
export const promoteSeedKey = (id: string) => ['promote-seed', id] as const;

export function usePromoteSeed(id: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (input: PromoteSeedInput) =>
      apiSend<PromotedSeed>('POST', `/api/seeds/${encodeURIComponent(id)}/promote`, input),
    mutationKey: promoteSeedKey(id),
    onError: (err: Error) => toast.error(err.message),
    // Pending until the refetches land, so a review page row leaves while the
    // sheet is still open and focus follows it (MMR-479).
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
    onSettled: () => void invalidate(),
  });
}
