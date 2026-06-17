import { STATUS_META } from "../lib/status";
import { cn } from "../lib/cn";
import type { WireNode } from "../api/types";
import { Card, CardContent, CardHeader } from "./ui/card";
import { DistributionBar } from "./distribution-bar";
import { StatusBadge } from "./status-badge";

export interface FleetAttention {
  inFlight: number;
  stale: number;
  blocked: number;
}

function AttentionCount({
  label,
  count,
  className,
}: {
  label: string;
  count: number;
  className: string;
}) {
  return (
    <span className={cn("flex items-baseline gap-1", count === 0 ? "text-ink-faint" : className)}>
      <span className="font-mono text-[0.9375rem] font-semibold tabular-nums">{count}</span>
      <span className="microlabel">{label}</span>
    </span>
  );
}

/** One project on the fleet: key, status word, rollup bar, attention counts. */
export function FleetCard({
  project,
  attention,
  onOpen,
}: {
  project: WireNode;
  attention: FleetAttention;
  onOpen: (key: string) => void;
}) {
  return (
    <Card className="transition-colors hover:border-line-bright">
      <button
        type="button"
        onClick={() => {
          onOpen(project.id);
        }}
        className="block w-full text-left focus-visible:outline-2 focus-visible:outline-accent"
      >
        <CardHeader className="flex-row items-center justify-between">
          <div className="flex items-baseline gap-2.5">
            <span className="font-mono text-lg font-bold tracking-tight text-ink-bright">
              {project.id}
            </span>
            <span className="truncate text-[0.75rem] text-ink-dim">{project.title}</span>
          </div>
          <StatusBadge status={project.status} />
        </CardHeader>
        <CardContent className="flex flex-col gap-2.5">
          <DistributionBar distribution={project.distribution ?? {}} />
          <div className="flex gap-4">
            <AttentionCount
              label="in flight"
              count={attention.inFlight}
              className={STATUS_META.in_progress.text}
            />
            <AttentionCount
              label="stale"
              count={attention.stale}
              className={STATUS_META.in_progress.text}
            />
            <AttentionCount
              label="blocked"
              count={attention.blocked}
              className={STATUS_META.blocked.text}
            />
          </div>
        </CardContent>
      </button>
    </Card>
  );
}
