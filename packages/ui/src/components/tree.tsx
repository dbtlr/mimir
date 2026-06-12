import { STATUS_META } from "../lib/status";
import { cn } from "../lib/cn";
import type { WireTreeNode } from "../api/types";
import { DistributionBar } from "./distribution-bar";
import { PriorityBadge, SizeBadge, StaleBadge } from "./signal-badges";
import { StatusDot } from "./status-dot";

/**
 * The tree lens: initiative → phase → task nesting, status words on every
 * row, distribution bars on containers. Children arrive rank-ordered from
 * the API and render in that order.
 */
export function TreeView({
  root,
  onOpenNode,
}: {
  root: WireTreeNode;
  onOpenNode: (id: string) => void;
}) {
  if (root.children.length === 0) {
    return <p className="px-3 py-6 text-center text-[12px] text-ink-faint">An empty project.</p>;
  }
  return (
    <div data-testid="tree" className="flex flex-col gap-1">
      {root.children.map((child) => (
        <TreeNode key={child.id} node={child} depth={0} onOpenNode={onOpenNode} />
      ))}
    </div>
  );
}

function TreeNode({
  node,
  depth,
  onOpenNode,
}: {
  node: WireTreeNode;
  depth: number;
  onOpenNode: (id: string) => void;
}) {
  const container = node.type !== "task";
  const meta = STATUS_META[node.status];
  const row = (
    <button
      type="button"
      onClick={() => {
        onOpenNode(node.id);
      }}
      className={cn(
        "flex w-full items-center gap-2 rounded-[4px] border border-transparent px-2 py-1.5 text-left",
        "transition-colors hover:border-line hover:bg-well-850 focus-visible:outline-2 focus-visible:outline-accent",
      )}
    >
      <StatusDot status={node.status} />
      <span className="font-mono text-[10px] text-ink-dim">{node.id}</span>
      <span
        className={cn(
          "truncate text-[12.5px]",
          container ? "font-semibold text-ink-bright" : "text-ink",
        )}
      >
        {node.title}
      </span>
      <span className={cn("microlabel hidden sm:inline", meta.text)}>{meta.label}</span>
      {node.verdicts?.stale === true && <StaleBadge />}
      {node.priority != null && <PriorityBadge priority={node.priority} />}
      {node.size != null && <SizeBadge size={node.size} />}
      {container && (
        <DistributionBar
          distribution={node.distribution ?? {}}
          className="ml-auto w-24 shrink-0 sm:w-36"
        />
      )}
    </button>
  );

  if (!container) {
    return row;
  }
  return (
    <details open className="group">
      <summary className="flex cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden
          className="w-3 shrink-0 text-center text-[9px] text-ink-faint transition-transform group-open:rotate-90"
        >
          ▶
        </span>
        <span className="min-w-0 flex-1">{row}</span>
      </summary>
      <div className="mt-1 ml-[13px] flex flex-col gap-1 border-l border-line pl-3">
        {node.children.map((child) => (
          <TreeNode key={child.id} node={child} depth={depth + 1} onOpenNode={onOpenNode} />
        ))}
      </div>
    </details>
  );
}
