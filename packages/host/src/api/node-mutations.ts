import { PRIORITY_VALUES, SIZE_VALUES } from '@mimir/contract';
import type { EngineInput, EngineNode, Grooming, Priority, Size } from '@mimir/contract';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';

import type { TransitionVerb } from '../lib/transitions';
import {
  abandon,
  annotate,
  block,
  depend,
  done,
  groom,
  move,
  park,
  reopen,
  returnTask,
  start,
  submit,
  tag,
  unblock,
  undepend,
  unpark,
  unqueue,
  untag,
  update,
} from './fns/nodes';
import { create, updateProject } from './fns/shell';
import { reasonBody, useInvalidateOnWrite } from './mutations';

/*
 * A node's writes (MMR-539): verbs, grooming, authoring, links, direction,
 * notes, and tags. Each goes through its Engine method's server function. A
 * write invalidates the shared write keys and never reads its echo.
 */

/** The server function behind each console verb, by the verb's name. */
const VERB_FNS = {
  abandon,
  block,
  done,
  park,
  reopen,
  return: returnTask,
  start,
  submit,
  unblock,
  unpark,
  unqueue,
} satisfies Record<TransitionVerb, unknown>;

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
      verb === 'unqueue'
        ? unqueue({ data: { id, reason: reason ?? '' } })
        : VERB_FNS[verb]({ data: { id, ...reasonBody(reason) } }),
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
      return groom({ data: { ids: [id], state, ...(trimmed === '' ? {} : { note: trimmed }) } });
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
    onSettled: invalidate,
  });
}

/**
 * One create for all three authorable node types (MMR-227) — the Engine
 * branches on `type`. `open_ended` is container-only; priority/size/external_ref
 * are task-only. `createData` drops a field that does not belong to the type,
 * and a priority or size outside the Engine's values, before the call. The
 * authoring sheet only offers valid values and sets task fields for tasks, so
 * the drop never fires from the UI.
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

/** The record a create answers, which the authoring sheet opens or links. */
export type CreatedNode = EngineNode;

/** The Engine's create input for `input`: a task takes the task-only fields, a container the container-only one. */
function createData(input: CreateNodeInput): EngineInput<'create'> {
  const {
    type,
    external_ref: externalRef,
    open_ended: openEnded,
    priority,
    size,
    ...shared
  } = input;
  if (type === 'task') {
    return {
      ...shared,
      externalRef,
      priority: PRIORITY_VALUES.find((p) => p === priority),
      size: SIZE_VALUES.find((s) => s === size),
      type,
    };
  }
  return { ...shared, openEnded, type };
}

export function useCreateNode() {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (input: CreateNodeInput) => create({ data: createData(input) }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: () => void invalidate(),
  });
}

/**
 * Dependencies are applied after the node exists (a create takes no
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
    mutationFn: ({ id, on }: DependInput) => depend({ data: { id, on } }),
    onError: silent ? undefined : (err: Error) => toast.error(err.message),
    onSettled: () => void invalidate(),
  });
}

/** The symmetric un-link, for edit-surface reuse. */
export function useUndepend() {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: ({ id, on }: DependInput) => undepend({ data: { id, on } }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: () => void invalidate(),
  });
}

export type UpdateNodeInput = {
  title?: string;
  /** Long prose clears with `null`; blank text is refused (see `proseOrNull`). */
  description?: string | null;
  /** Owned direction prose (ADR 0026) — containers only; tasks never carry it. */
  next?: string | null;
  summary?: string;
  priority?: Priority;
  size?: Size;
  externalRef?: string;
};

export function useUpdateNode(id: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (fields: UpdateNodeInput) => update({ data: { ...fields, id } }),
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
    mutationFn: (to: string) => move({ data: { id, to } }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: () => void invalidate(),
  });
}

/**
 * What owns a direction (ADR 0026 Decision 2): a project addresses by key, an
 * initiative or phase by node id. Tasks never carry one.
 */
export type DirectionTarget = { kind: 'project'; key: string } | { kind: 'node'; id: string };

/**
 * Write a subject's direction (MMR-390): `updateProject` for a project,
 * `update` for a container, since the two Engine methods take the same `next`.
 * Unlike its siblings this one
 * AWAITS the invalidation from `onSettled`: the editor closes on the settled
 * mutation, so awaiting here is what keeps the reading pane from flashing the
 * prose the operator just replaced.
 */
export function useUpdateDirection(target: DirectionTarget) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (next: string | null) =>
      target.kind === 'project'
        ? updateProject({ data: { id: target.key, next } })
        : update({ data: { id: target.id, next } }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: invalidate,
  });
}

export function useAnnotate(id: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (content: string) => annotate({ data: { content, id } }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: () => void invalidate(),
  });
}

export function useTag(id: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (name: string) => tag({ data: { ids: [id], tags: [name] } }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: () => void invalidate(),
  });
}

export function useUntag(id: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (name: string) => untag({ data: { ids: [id], tags: [name] } }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: () => void invalidate(),
  });
}
