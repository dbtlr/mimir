import { PRIORITY_VALUES, SIZE_VALUES } from '@mimir/contract';
import type { EngineInput, EngineOutput, SeedKind } from '@mimir/contract';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';

import {
  seedCreate,
  seedPark,
  seedPromote,
  seedReject,
  seedResolve,
  seedUnpark,
  seedUpdate,
} from './fns/browse';
import { reasonBody, useInvalidateOnWrite } from './mutations';

/*
 * A seed's writes (MMR-540): filing, triage verbs, promotion, and edits, each
 * through its Engine method's server function. Every write invalidates the
 * shared write keys; the Engine's refusal toasts verbatim.
 */

/**
 * File a seed (MMR-247). Console-filed seeds are self-filed: `requester` is
 * never sent (the Engine nulls it → "you"). `kind` defaults to `idea` at the
 * call site; `description` is optional (edited later in detail).
 */
export type FileSeedInput = {
  project: string;
  title: string;
  kind: SeedKind;
  description?: string;
};

export function useFileSeed() {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (input: FileSeedInput) => seedCreate({ data: input }),
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
 * Reject a seed (MMR-247). The Engine requires a non-empty `reason`; the reason
 * dialog gates confirm on it, so the call always carries one.
 */
export function useRejectSeed(id: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (reason: string) => seedReject({ data: { id, reason } }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: invalidate,
  });
}

/** Resolve a seed (MMR-247), `reason` required (mirror of reject). */
export function useResolveSeed(id: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (reason: string) => seedResolve({ data: { id, reason } }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: invalidate,
  });
}

/** Park a seed (MMR-473); the reason is optional, as on a task park. */
export function useParkSeed(id: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (reason?: string) => seedPark({ data: { id, ...reasonBody(reason) } }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: invalidate,
  });
}

/** Unpark a seed (MMR-473), back to the untriaged queue. */
export function useUnparkSeed(id: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: () => seedUnpark({ data: { id } }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: invalidate,
  });
}

/**
 * Promote a seed into work (MMR-248), create mode: `parent` is the chosen
 * home, title/description ride as edited, and priority/size/tags when the
 * sheet collected them. `['seeds']` and the node keys both invalidate (the
 * task is a new node), so the queue re-groups the seed to PROMOTED and the
 * boards pick up the spawned task.
 */
export type PromoteSeedInput = {
  parent: string;
  title?: string;
  description?: string;
  priority?: string;
  size?: string;
  tags?: string[];
};

/** The promote echo: the seed, the spawned task id, and `created` in create mode. */
export type PromotedSeed = EngineOutput<'seedPromote'>;

/** A seed's promote, so a surface can ask whether one is still in flight. */
export const promoteSeedKey = (id: string) => ['promote-seed', id] as const;

/** The promote input for the Engine; the sheet only offers real priorities and sizes. */
function promoteInput(id: string, input: PromoteSeedInput): EngineInput<'seedPromote'> {
  const { priority, size, ...rest } = input;
  const out: EngineInput<'seedPromote'> = { ...rest, id };
  const chosenPriority = PRIORITY_VALUES.find((value) => value === priority);
  if (chosenPriority !== undefined) {
    out.priority = chosenPriority;
  }
  const chosenSize = SIZE_VALUES.find((value) => value === size);
  if (chosenSize !== undefined) {
    out.size = chosenSize;
  }
  return out;
}

export function usePromoteSeed(id: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (input: PromoteSeedInput) => seedPromote({ data: promoteInput(id, input) }),
    mutationKey: promoteSeedKey(id),
    onError: (err: Error) => toast.error(err.message),
    // Pending until the refetches land, so a review page row leaves while the
    // sheet is still open and focus follows it (MMR-479).
    onSettled: invalidate,
  });
}

export type UpdateSeedInput = {
  title?: string;
  kind?: SeedKind;
  /** Clears with `null`; blank text is refused (see `proseOrNull`). */
  description?: string | null;
};

/**
 * Patch a live seed (MMR-247). The Engine refuses a terminal (frozen) seed, so
 * the detail surfaces edit only while the seed is live; `requester`/`spawned`
 * are verb-owned and never patched here.
 */
export function useUpdateSeed(id: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (fields: UpdateSeedInput) => seedUpdate({ data: { ...fields, id } }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: () => void invalidate(),
  });
}
