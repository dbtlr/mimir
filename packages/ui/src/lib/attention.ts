import type { WireNode } from '../api/types';

/**
 * Why a node is in the Attention set — the three arms, in action-impact order.
 * `under_review`/`blocked` are the node's actual status word (they drive a status
 * dot); `going_cold` is *not* a status word — a task surfaced purely because it
 * is stale is labeled by its going-cold nudge, not its (healthy) status (MMR-111).
 */
export type AttentionReason = 'under_review' | 'blocked' | 'going_cold';

export type AttentionItem = {
  node: WireNode;
  reason: AttentionReason;
  stale: boolean;
};

/**
 * The cross-project set that needs the operator (MMR-80, reconciled MMR-103):
 * **under_review first, then blocked, then stale-only**, deduped by id — ordered
 * by "how much your action moves it" (the lane-ordering principle). `under_review`
 * (Awaiting you) is the strongest such signal, so it leads. `in_progress`/`ready`
 * stay excluded when healthy: active, un-awaited work is not an alert. A stale
 * one is kept but surfaced as **going cold** — the nudge, not its status word
 * (MMR-111); see the "Attention" glossary entry.
 */
export function attentionItems(
  underReview: WireNode[],
  blocked: WireNode[],
  stale: WireNode[],
): AttentionItem[] {
  const staleIds = new Set(stale.map((n) => n.id));
  const seen = new Set<string>();
  const items: AttentionItem[] = [];
  const push = (node: WireNode, reason: AttentionReason) => {
    if (seen.has(node.id)) {
      return;
    }
    seen.add(node.id);
    items.push({ node, reason, stale: staleIds.has(node.id) || node.verdicts?.stale === true });
  };
  for (const node of underReview) {
    push(node, 'under_review');
  }
  for (const node of blocked) {
    push(node, 'blocked');
  }
  for (const node of stale) {
    // Stale-only: surfaced by staleness, not by an under_review/blocked status —
    // its status word is a healthy in_progress/ready, so label it going cold.
    push(node, 'going_cold');
  }
  return items;
}
