import type { StatusWord } from "@mimir/contract";
import type { WireNode } from "../api/types";

export interface AttentionItem {
  node: WireNode;
  /** Why it's on the list — drives the dot; `stale` rides as a marker. */
  reason: StatusWord;
  stale: boolean;
}

/**
 * The cross-project set that needs the operator (MMR-80, reconciled MMR-103):
 * **under_review first, then blocked, then stale-only**, deduped by id — ordered
 * by "how much your action moves it" (the attention-band principle). `under_review`
 * (Awaiting you) is the strongest such signal, so it leads. `in_progress`/`ready`
 * stay excluded: active, un-awaited work is healthy, not an alert (the refined
 * "attention" definition; see the glossary).
 */
export function attentionItems(
  underReview: WireNode[],
  blocked: WireNode[],
  stale: WireNode[],
): AttentionItem[] {
  const staleIds = new Set(stale.map((n) => n.id));
  const seen = new Set<string>();
  const items: AttentionItem[] = [];
  const push = (node: WireNode, reason: StatusWord) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    items.push({ node, reason, stale: staleIds.has(node.id) || node.verdicts?.stale === true });
  };
  for (const node of underReview) push(node, "under_review");
  for (const node of blocked) push(node, "blocked");
  for (const node of stale) push(node, node.status);
  return items;
}
