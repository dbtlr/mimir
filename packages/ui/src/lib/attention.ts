import type { StatusWord } from "@mimir/contract";
import type { WireNode } from "../api/types";

export interface AttentionItem {
  node: WireNode;
  /** Why it's on the list — drives the dot; `stale` rides as a marker. */
  reason: StatusWord;
  stale: boolean;
}

/**
 * The cross-project intervention set (MMR-80): things needing the operator to
 * unstick them — **blocked first, then stale-only**, deduped by id. In-flight is
 * deliberately excluded: active work is healthy, not an alert (the grilled
 * definition of "attention"; see the glossary).
 */
export function attentionItems(blocked: WireNode[], stale: WireNode[]): AttentionItem[] {
  const staleIds = new Set(stale.map((n) => n.id));
  const seen = new Set<string>();
  const items: AttentionItem[] = [];
  const push = (node: WireNode, reason: StatusWord) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    items.push({ node, reason, stale: staleIds.has(node.id) || node.verdicts?.stale === true });
  };
  for (const node of blocked) push(node, "blocked");
  for (const node of stale) push(node, node.status);
  return items;
}
