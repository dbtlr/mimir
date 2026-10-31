import { useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { archive, create, unarchive, updateProject } from './fns/shell';
import { useInvalidateOnWrite } from './mutations';
import { projectsQuery } from './shell-queries';

/*
 * The shell's writes (MMR-537): project create, edit, pin, archive, and
 * unarchive, each through its Engine method's server function. Every write
 * still invalidates the shared write keys; none reads its echo.
 */

export type CreateProjectInput = {
  key: string;
  name: string;
  description?: string;
};

/**
 * Create a project (MMR-230) through the Engine's `create`. A project takes
 * `name` + `key` (not `title`) — the sheet maps TITLE→name, KEY→key. The
 * Engine owns key uniqueness/validity; its refusal toasts verbatim.
 */
export function useCreateProject() {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (input: CreateProjectInput) => create({ data: { ...input, type: 'project' } }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: () => void invalidate(),
  });
}

/**
 * Archive a project (ADR 0015): frozen and hidden, never deleted. There is no
 * confirm — the caller raises an undo toast whose Unarchive is the recovery.
 */
export function useArchiveProject(key: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: () => archive({ data: { id: key } }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: () => void invalidate(),
  });
}

export type UpdateProjectInput = {
  title?: string;
  /** Long prose clears with `null`; blank text is refused (see `proseOrNull`). */
  description?: string | null;
  /** Owned direction prose (ADR 0026) — replace-whole, re-authored per session. */
  next?: string | null;
};

/** Edit a project's fields; the form's `title` is the project's name. */
export function useUpdateProject(key: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: ({ title, ...fields }: UpdateProjectInput) =>
      updateProject({ data: { ...fields, id: key, name: title } }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: () => void invalidate(),
  });
}

/** The key under which every pin mutation runs, so the switcher can find the pending ones. */
const PIN_MUTATION = ['pin-project'] as const;

export type PinInput = { key: string; pinned: boolean };

const isPinInput = (value: unknown): value is PinInput =>
  typeof value === 'object' &&
  value !== null &&
  'key' in value &&
  typeof value.key === 'string' &&
  'pinned' in value &&
  typeof value.pinned === 'boolean';

/**
 * Pin or unpin a project (MMR-497) through `updateProject`. The
 * switcher shows a pin the moment it is chosen by laying `usePendingPins` over
 * the server's list, not by writing the cache, so a background poll cannot
 * undo it. A failed write toasts and its pin simply drops out of the pending
 * set. The mutation stays pending until the project list has refetched, so the
 * row never shows the server's older value in between.
 */
export function usePinProject() {
  const qc = useQueryClient();
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: ({ key, pinned }: PinInput) => updateProject({ data: { id: key, pinned } }),
    mutationKey: PIN_MUTATION,
    onError: (err: Error) => {
      toast.error(err.message);
    },
    onSettled: async () => {
      void invalidate();
      // Only the project list gates the pending state: it is what the pin overlays.
      await qc.invalidateQueries({ queryKey: projectsQuery.queryKey });
    },
  });
}

/** The pins in flight, as the flag each project is on its way to; the latest pin per project wins. */
export function usePendingPins(): ReadonlyMap<string, boolean> {
  const pending = useMutationState({
    filters: { mutationKey: PIN_MUTATION, status: 'pending' },
    select: (mutation) => mutation.state.variables,
  });
  return new Map(pending.filter(isPinInput).map(({ key, pinned }) => [key, pinned]));
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
    mutationFn: () => unarchive({ data: { id: key } }),
    onError: (err: Error) => toast.error(err.message),
    // Pending until the archived list is fresh: the archived page reads it, so a
    // stale list would re-offer Unarchive for a project that is already active.
    onSettled: invalidate,
  });
}
