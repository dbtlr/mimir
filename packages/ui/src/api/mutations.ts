import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiSend } from "./client";
import type { WireNode } from "./types";
import type { ReorderArgs } from "../lib/reorder";
import type { TransitionVerb } from "../lib/transitions";

/** Every read key a write can stale. Broad invalidation is fine — the server is loopback. */
const WRITE_KEYS: readonly (readonly string[])[] = [
  ["board"],
  ["node"],
  ["nodes"],
  ["projects"],
  ["project"],
  ["tree"],
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
  return trimmed !== undefined && trimmed !== "" ? { reason: trimmed } : undefined;
}

export interface TransitionInput {
  verb: TransitionVerb;
  reason?: string;
}

export function useTransition(id: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: ({ verb, reason }: TransitionInput) =>
      apiSend<WireNode>("POST", `/api/nodes/${encodeURIComponent(id)}/${verb}`, reasonBody(reason)),
    onError: (err: Error) => {
      toast.error(err.message);
    },
    onSettled: invalidate,
  });
}

/** Reorder is board-level: the id isn't known until a drop, so it's given at mutate time. */
export interface ReorderInput extends ReorderArgs {
  id: string;
}

export function useReorder() {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: ({ id, ...args }: ReorderInput) =>
      apiSend<WireNode>("POST", `/api/nodes/${encodeURIComponent(id)}/reorder`, args),
    onError: (err: Error) => {
      toast.error(err.message);
    },
    onSettled: invalidate,
  });
}

export interface CreateTaskInput {
  parent: string;
  title: string;
  description?: string;
  priority?: string;
  size?: string;
  external_ref?: string;
  tags?: string[];
}

export function useCreateTask() {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (input: CreateTaskInput) =>
      apiSend<WireNode>("POST", "/api/nodes", { type: "task", ...input }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: invalidate,
  });
}

export interface UpdateNodeInput {
  title?: string;
  description?: string;
  priority?: string;
  size?: string;
  external_ref?: string;
}

export function useUpdateNode(id: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (fields: UpdateNodeInput) =>
      apiSend<WireNode>("PATCH", `/api/nodes/${encodeURIComponent(id)}`, fields),
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
      apiSend<WireNode>("POST", `/api/nodes/${encodeURIComponent(id)}/move`, { to }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: invalidate,
  });
}

export interface UpdateProjectInput {
  title?: string;
  description?: string;
}

export function useUpdateProject(key: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (fields: UpdateProjectInput) =>
      apiSend<WireNode>("PATCH", `/api/projects/${encodeURIComponent(key)}`, fields),
    onError: (err: Error) => toast.error(err.message),
    onSettled: invalidate,
  });
}

export function useAnnotate(id: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (content: string) =>
      apiSend<WireNode>("POST", `/api/nodes/${encodeURIComponent(id)}/annotations`, { content }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: invalidate,
  });
}

export function useTag(id: string) {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (tag: string) =>
      apiSend<WireNode>(
        "PUT",
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
        "DELETE",
        `/api/nodes/${encodeURIComponent(id)}/tags/${encodeURIComponent(tag)}`,
        undefined,
      ),
    onError: (err: Error) => toast.error(err.message),
    onSettled: invalidate,
  });
}
