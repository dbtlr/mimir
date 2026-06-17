import type { WireNode } from "../api/types";
import { Card, CardContent, CardHeader } from "./ui/card";
import { DistributionBar } from "./distribution-bar";
import { StatusBadge } from "./status-badge";

/**
 * One project on the fleet: key, title, status, the rollup bar, and the **ready**
 * count — the one actionable number (MMR-82). The old in-flight/stale/blocked
 * triplet is gone: the bar already shows the distribution, and stuck work now
 * lives in the global attention alert.
 */
export function FleetCard({
  project,
  ready,
  onOpen,
}: {
  project: WireNode;
  /** Leaf ready-task count (from the portfolio ready read), not the rollup bucket. */
  ready: number;
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
          <div className="flex items-baseline gap-1.5">
            <span className="font-mono text-lg font-semibold text-status-ready tabular-nums">
              {ready}
            </span>
            <span className="microlabel text-ink-dim">ready</span>
          </div>
        </CardContent>
      </button>
    </Card>
  );
}
