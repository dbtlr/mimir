import type { StatusWord } from "@mimir/contract";
import { cn } from "../lib/cn";
import { STATUS_META } from "../lib/status";
import { StatusDot } from "./status-dot";

/** A status word as a tinted chip — the same meta the bars and headers use. */
export function StatusBadge({ status, className }: { status: StatusWord; className?: string }) {
  const meta = STATUS_META[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[3px] px-1.5 py-0.5 text-[11px] font-semibold",
        meta.chip,
        className,
      )}
    >
      <StatusDot status={status} />
      {meta.label}
    </span>
  );
}
