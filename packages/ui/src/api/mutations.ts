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

/** park/block/abandon carry a trimmed reason; plain verbs send no body. */
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
