import { cn } from "../lib/cn";
import { STATUS_META } from "../lib/status";
import type { WireNode } from "../api/types";
import { Badge } from "./ui/badge";
import { PriorityBadge, SizeBadge, StaleBadge } from "./signal-badges";

const SHOWN_TAGS = 3;

/**
 * One board card: a status-cut left edge, mono id, dense title, and the
 * signal row (priority/size badges, tag chips, stale marker). Read-only —
 * the only affordance is opening the drawer.
 */
export function NodeCard({ node, onOpen }: { node: WireNode; onOpen: (id: string) => void }) {
  const tags = node.tags ?? [];
  const overflow = tags.length - SHOWN_TAGS;
  return (
    <button
      type="button"
      onClick={() => {
        onOpen(node.id);
      }}
      className={cn(
        "group block w-full rounded-[4px] border border-line border-l-2 bg-well-850 p-2 text-left transition-colors",
        "hover:border-line-bright hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent",
        STATUS_META[node.status].border.replace("border-", "border-l-"),
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[10px] text-ink-dim">{node.id}</span>
        {node.verdicts?.stale === true && <StaleBadge />}
      </div>
      <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-ink group-hover:text-ink-bright">
        {node.title}
      </p>
      {(node.priority != null || node.size != null || tags.length > 0) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {node.priority != null && <PriorityBadge priority={node.priority} />}
          {node.size != null && <SizeBadge size={node.size} />}
          {tags.slice(0, SHOWN_TAGS).map((t) => (
            <Badge key={t.tag} variant="outline" className="max-w-28 truncate">
              {t.tag}
            </Badge>
          ))}
          {overflow > 0 && <Badge variant="outline">+{overflow}</Badge>}
        </div>
      )}
    </button>
  );
}
