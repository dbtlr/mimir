import type { StatusWord } from "@mimir/contract";
import { cn } from "../lib/cn";
import { projectKeyOf, type WireNode } from "../api/types";
import { StatusDot } from "./status-dot";
import { StaleBadge } from "./signal-badges";

export interface AttentionItem {
  node: WireNode;
  /** Why it's on the strip — drives the dot; stale rides as a marker. */
  reason: StatusWord;
  stale: boolean;
}

/**
 * Merge the three attention reads into one strip: in-flight first, then
 * stuck (blocked, then stale-only), deduped by id.
 */
export function attentionItems(
  inFlight: WireNode[],
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
  for (const node of inFlight) push(node, "in_progress");
  for (const node of blocked) push(node, "blocked");
  for (const node of stale) push(node, node.status);
  return items;
}

/**
 * The cross-project attention strip: everything in flight anywhere, plus
 * stuck items — the fleet's first glance.
 */
export function AttentionStrip({
  items,
  onOpenNode,
}: {
  items: AttentionItem[];
  onOpenNode: (id: string) => void;
}) {
  if (items.length === 0) {
    return (
      <p className="rounded-md border border-line bg-well-850/60 px-3 py-2 text-[12px] text-ink-faint">
        Nothing in flight, nothing stuck.
      </p>
    );
  }
  return (
    <ol data-testid="attention-strip" className="flex gap-1.5 overflow-x-auto pb-1">
      {items.map(({ node, reason, stale }) => (
        <li key={node.id} className="shrink-0">
          <button
            type="button"
            onClick={() => {
              onOpenNode(node.id);
            }}
            className={cn(
              "flex max-w-72 items-center gap-2 rounded-[4px] border border-line bg-well-850 px-2 py-1.5 text-left",
              "transition-colors hover:border-line-bright hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent",
            )}
          >
            <StatusDot status={reason} />
            <span className="font-mono text-[10px] text-ink-dim">{node.id}</span>
            <span className="microlabel text-ink-faint">{projectKeyOf(node.id)}</span>
            <span className="truncate text-[12px] text-ink">{node.title}</span>
            {stale && <StaleBadge />}
          </button>
        </li>
      ))}
    </ol>
  );
}
