import type { Distribution, StatusWord } from '@mimir/contract';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { useTransition } from '../api/mutations';
import type { WireTreeNode } from '../api/types';
import { cn } from '../lib/cn';
import { STATUS_META } from '../lib/status';
import { DistributionBar } from './distribution-bar';
import { ReasonDialog } from './reason-dialog';
import { StatusDot } from './status-dot';
import { ActionButton } from './ui/action-button';
import { Card } from './ui/card';

/**
 * The tree lens — Meridian grouped panels (option 11a). Three flat visual
 * levels: initiative/standing section headers, phase panels, and leaf rows.
 * The `root` contract and `onOpenNode` callback are unchanged; `offline` inerts
 * the inline verdict buttons the same way every other write surface is gated.
 * Containers always read a distribution + interpreted word (never a bare
 * status); done phases fold to one recessed row and parked leaves fold to one
 * trailing row, both expandable in place (the note-expand height transition).
 */
export function TreeView({
  root,
  onOpenNode,
  offline,
}: {
  root: WireTreeNode;
  onOpenNode: (id: string) => void;
  offline?: boolean;
}) {
  if (root.children.length === 0) {
    return <p className="px-3 py-6 text-center text-xs text-ink-faint">An empty project.</p>;
  }

  // Top level renders one group per container; any bare task children collect
  // into a headerless panel. Initiatives never fold here — folding is a
  // phase-level idiom scoped to a group's own children.
  const groups: ReactNode[] = [];
  let taskRun: WireTreeNode[] = [];
  let key = 0;
  const flushTasks = () => {
    if (taskRun.length > 0) {
      const run = taskRun;
      taskRun = [];
      groups.push(
        <BareLeafPanel
          key={`t${String(key++)}`}
          tasks={run}
          onOpenNode={onOpenNode}
          offline={offline}
        />,
      );
    }
  };
  for (const child of root.children) {
    if (child.type === 'task') {
      taskRun.push(child);
    } else {
      flushTasks();
      groups.push(<Group key={child.id} node={child} onOpenNode={onOpenNode} offline={offline} />);
    }
  }
  flushTasks();

  return (
    <div data-testid="tree" className="flex flex-col gap-4">
      {groups}
    </div>
  );
}

/** The phase-header interpreted word — status vocabulary, `in_progress` → IN MOTION. */
function interpretedWord(status: StatusWord): string {
  return status === 'in_progress' ? 'IN MOTION' : STATUS_META[status].label.toUpperCase();
}

/** Total leaf tasks a container rolls up (its distribution is the leaf tally). */
function sumDistribution(dist: Distribution): number {
  return Object.values(dist).reduce<number>((sum, n) => sum + (n ?? 0), 0);
}

/**
 * The terse leaf-count headline for a group: `N done · M live · K review`,
 * zero buckets omitted, joined in that fixed order. `live` folds ready +
 * in-progress + awaiting; held/terminal buckets stay in the bar, out of the
 * text. Empty when all three are zero (the bar alone still carries nuance).
 */
function leafCountSummary(dist: Distribution): string {
  const done = dist.done ?? 0;
  const review = dist.under_review ?? 0;
  const live = (dist.ready ?? 0) + (dist.in_progress ?? 0) + (dist.awaiting ?? 0);
  const parts: string[] = [];
  if (done > 0) {
    parts.push(`${String(done)} done`);
  }
  if (live > 0) {
    parts.push(`${String(live)} live`);
  }
  if (review > 0) {
    parts.push(`${String(review)} review`);
  }
  return parts.join(' · ');
}

/** The ▾/▸ disclosure glyph shared by every caret on the surface. */
function Caret({ open }: { open: boolean }) {
  return (
    <span aria-hidden className="w-2.5 shrink-0 text-[10px] leading-none text-ink-faint">
      {open ? '▾' : '▸'}
    </span>
  );
}

/**
 * The note-expand height transition (motion-budget item 3) — the two fold rows
 * animate their reveal via a grid-rows 0fr↔1fr collapse; nothing else moves.
 * When collapsed the subtree is `inert`, so its clipped buttons stay out of the
 * tab order and the accessibility tree (matching the native `<details>` it
 * replaces — `overflow:hidden` alone would leave them keyboard-reachable).
 */
function Collapsible({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        'grid transition-[grid-template-rows] duration-200 ease-out',
        open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
      )}
    >
      <div className="overflow-hidden" inert={!open}>
        {children}
      </div>
    </div>
  );
}

/**
 * An initiative (section header + teal spine) or a standing home (`STANDING` /
 * ∞ / OPEN FOR FILING, neutral spine). Structurally identical — only the
 * header copy and spine hue differ; children render the same either way.
 */
function Group({
  node,
  onOpenNode,
  offline,
}: {
  node: WireTreeNode;
  onOpenNode: (id: string) => void;
  offline?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const standing = node.open_ended === true;
  const summary = leafCountSummary(node.distribution ?? {});

  return (
    <section>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
        }}
        className="flex w-full items-center gap-2.5 px-1 pt-1.5 pb-2.5 text-left focus-visible:outline-2 focus-visible:outline-accent"
      >
        <Caret open={open} />
        <span className={cn('microlabel', standing ? 'text-ink-faint' : 'text-accent-foreground')}>
          {standing ? 'STANDING' : 'INITIATIVE'}
        </span>
        <span className="min-w-0 truncate text-[15px] font-bold text-ink-bright">{node.title}</span>
        {standing && (
          <span className="shrink-0 font-mono text-[12px] text-accent-foreground">∞</span>
        )}
        <span className="shrink-0 font-mono text-mono-id text-ink-faint">{node.id}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2.5">
          {standing ? (
            <span className="microlabel text-accent-foreground">OPEN FOR FILING</span>
          ) : (
            summary !== '' && <span className="text-[11px] text-ink-faint">{summary}</span>
          )}
          <DistributionBar distribution={node.distribution ?? {}} className="w-[150px]" />
        </span>
      </button>
      {open && (
        <div
          className={cn(
            'ml-1.5 flex flex-col gap-2.5 pl-4',
            standing ? 'border-l border-line' : 'border-l-2 border-accent/20',
          )}
        >
          <GroupChildren nodes={node.children} onOpenNode={onOpenNode} offline={offline} />
        </div>
      )}
    </section>
  );
}

/**
 * A group's children: container children become phase panels, runs of
 * consecutive done phases fold into one recessed row, and runs of bare task
 * children collect into a headerless leaf panel.
 */
function GroupChildren({
  nodes,
  onOpenNode,
  offline,
}: {
  nodes: WireTreeNode[];
  onOpenNode: (id: string) => void;
  offline?: boolean;
}) {
  const out: ReactNode[] = [];
  let taskRun: WireTreeNode[] = [];
  let doneRun: { node: WireTreeNode; ordinal: number }[] = [];
  let ordinal = -1;
  let key = 0;

  const flushTasks = () => {
    if (taskRun.length > 0) {
      const run = taskRun;
      taskRun = [];
      out.push(
        <BareLeafPanel
          key={`t${String(key++)}`}
          tasks={run}
          onOpenNode={onOpenNode}
          offline={offline}
        />,
      );
    }
  };
  const flushDone = () => {
    if (doneRun.length > 0) {
      const run = doneRun;
      doneRun = [];
      out.push(
        <FoldedDonePhases
          key={`d${String(key++)}`}
          phases={run}
          onOpenNode={onOpenNode}
          offline={offline}
        />,
      );
    }
  };

  for (const child of nodes) {
    if (child.type === 'task') {
      flushDone();
      taskRun.push(child);
    } else {
      flushTasks();
      ordinal += 1;
      if (child.status === 'done') {
        doneRun.push({ node: child, ordinal });
      } else {
        flushDone();
        out.push(
          <PhasePanel key={child.id} node={child} onOpenNode={onOpenNode} offline={offline} />,
        );
      }
    }
  }
  flushTasks();
  flushDone();

  return <>{out}</>;
}

/** A phase panel: health-readout header + its leaf rows (open by default). */
function PhasePanel({
  node,
  onOpenNode,
  offline,
}: {
  node: WireTreeNode;
  onOpenNode: (id: string) => void;
  offline?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const meta = STATUS_META[node.status];

  return (
    <Card className="overflow-hidden rounded-[12px]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
        }}
        className={cn(
          'flex w-full items-center gap-2.5 px-4 py-3 text-left focus-visible:outline-2 focus-visible:outline-accent',
          open && 'border-b border-line',
        )}
      >
        <Caret open={open} />
        <span className="min-w-0 truncate text-body font-semibold text-ink-bright">
          {node.title}
        </span>
        <span className="shrink-0 font-mono text-mono-id text-ink-faint">{node.id}</span>
        <DistributionBar distribution={node.distribution ?? {}} className="ml-1.5 w-[120px]" />
        <span className={cn('microlabel ml-auto shrink-0', meta.text)}>
          {interpretedWord(node.status)}
        </span>
      </button>
      {open && <LeafList tasks={node.children} onOpenNode={onOpenNode} offline={offline} />}
    </Card>
  );
}

/** A headerless panel of leaf rows — a group whose children are tasks directly. */
function BareLeafPanel({
  tasks,
  onOpenNode,
  offline,
}: {
  tasks: WireTreeNode[];
  onOpenNode: (id: string) => void;
  offline?: boolean;
}) {
  return (
    <Card className="overflow-hidden rounded-[12px]">
      <LeafList tasks={tasks} onOpenNode={onOpenNode} offline={offline} />
    </Card>
  );
}

/** Leaf rows with the panel's own parked children folded to one trailing row. */
function LeafList({
  tasks,
  onOpenNode,
  offline,
}: {
  tasks: WireTreeNode[];
  onOpenNode: (id: string) => void;
  offline?: boolean;
}) {
  const parked = tasks.filter((t) => t.status === 'parked');
  const shown = tasks.filter((t) => t.status !== 'parked');
  return (
    <div>
      {shown.map((t) => (
        <LeafRow key={t.id} node={t} onOpenNode={onOpenNode} offline={offline} />
      ))}
      {parked.length > 0 && (
        <FoldedParked tasks={parked} onOpenNode={onOpenNode} offline={offline} />
      )}
    </div>
  );
}

/**
 * A leaf task row. Clicking anywhere on the row (outside the inline verdict
 * buttons) opens the node. Under-review rows route to `UnderReviewLeafRow`,
 * which layers the inline Approve/Return verdicts and the violet wash; keeping
 * the mutation hook there means the react-query observer only mounts on the
 * handful of rows that can actually mutate, not on every leaf in the tree.
 */
function LeafRow({
  node,
  onOpenNode,
  offline,
}: {
  node: WireTreeNode;
  onOpenNode: (id: string) => void;
  offline?: boolean;
}) {
  if (node.status === 'under_review') {
    return <UnderReviewLeafRow node={node} onOpenNode={onOpenNode} offline={offline} />;
  }
  const meta = STATUS_META[node.status];
  return (
    <button
      type="button"
      onClick={() => {
        onOpenNode(node.id);
      }}
      className="flex w-full items-center gap-2.5 border-b border-line px-4 py-[9px] text-left last:border-b-0 focus-visible:outline-2 focus-visible:outline-accent"
    >
      <StatusDot status={node.status} />
      <span className="w-[70px] shrink-0 truncate font-mono text-mono-id text-ink-faint">
        {node.id}
      </span>
      <span className="min-w-0 truncate text-body font-medium text-ink-bright">{node.title}</span>
      <span className={cn('microlabel ml-auto shrink-0', meta.text)}>{meta.label}</span>
    </button>
  );
}

/**
 * An under-review leaf row: the faint violet wash plus inline Approve (`done`)
 * / Return… (`return`, via the shared reason dialog), still showing the trailing
 * UNDER REVIEW word. The title cluster and the trailing status-word region are
 * each their own open target, so every part of the row outside the two verdict
 * buttons fires `onOpenNode`.
 */
function UnderReviewLeafRow({
  node,
  onOpenNode,
  offline,
}: {
  node: WireTreeNode;
  onOpenNode: (id: string) => void;
  offline?: boolean;
}) {
  const meta = STATUS_META[node.status];
  const { mutate } = useTransition(node.id);
  const [returning, setReturning] = useState(false);

  return (
    <div className="flex items-center gap-2.5 border-b border-line bg-attention/5 px-4 py-[9px] last:border-b-0">
      <button
        type="button"
        onClick={() => {
          onOpenNode(node.id);
        }}
        className="flex min-w-0 items-center gap-2.5 text-left focus-visible:outline-2 focus-visible:outline-accent"
      >
        <StatusDot status={node.status} />
        <span className="w-[70px] shrink-0 truncate font-mono text-mono-id text-ink-faint">
          {node.id}
        </span>
        <span className="min-w-0 truncate text-body font-medium text-ink-bright">{node.title}</span>
      </button>
      <div className="flex shrink-0 items-center gap-2">
        <ActionButton
          variant="attention"
          disabled={offline}
          onClick={() => {
            mutate({ verb: 'done' });
          }}
          className="rounded-md px-3 py-[3px] text-[11px] font-bold"
        >
          Approve
        </ActionButton>
        <ActionButton
          variant="outline"
          disabled={offline}
          onClick={() => {
            setReturning(true);
          }}
          className="rounded-md px-3 py-[3px] text-[11px] text-ink-dim"
        >
          Return…
        </ActionButton>
      </div>
      <button
        type="button"
        aria-label={`Open ${node.id}`}
        onClick={() => {
          onOpenNode(node.id);
        }}
        className="ml-auto flex flex-1 items-center justify-end focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span className={cn('microlabel shrink-0', meta.text)}>{meta.label}</span>
      </button>
      <ReasonDialog
        verb="return"
        open={returning}
        onClose={() => {
          setReturning(false);
        }}
        onConfirm={(reason) => {
          mutate(reason === '' ? { verb: 'return' } : { reason, verb: 'return' });
          setReturning(false);
        }}
      />
    </div>
  );
}

/**
 * A run of consecutive done phases folded to one recessed row (`Phases N–M` /
 * `DONE · count`); clicking expands the phases in place as ordinary panels.
 */
function FoldedDonePhases({
  phases,
  onOpenNode,
  offline,
}: {
  phases: { node: WireTreeNode; ordinal: number }[];
  onOpenNode: (id: string) => void;
  offline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const start = phases[0]?.ordinal ?? 0;
  const end = phases[phases.length - 1]?.ordinal ?? start;
  const count = phases.reduce((sum, p) => sum + sumDistribution(p.node.distribution ?? {}), 0);
  const label = start === end ? `Phase ${String(start)}` : `Phases ${String(start)}–${String(end)}`;

  return (
    <div>
      <Card variant="recessed" className="overflow-hidden rounded-[12px] opacity-65">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpen((v) => !v);
          }}
          className="flex w-full items-center gap-2.5 px-4 py-3 text-left focus-visible:outline-2 focus-visible:outline-accent"
        >
          <Caret open={open} />
          <span className="min-w-0 truncate text-body font-medium text-ink-dim">{label}</span>
          <span className="microlabel ml-auto shrink-0 text-status-done">
            DONE · {String(count)}
          </span>
        </button>
      </Card>
      <Collapsible open={open}>
        <div className="flex flex-col gap-2.5 pt-2.5">
          {phases.map((p) => (
            <PhasePanel key={p.node.id} node={p.node} onOpenNode={onOpenNode} offline={offline} />
          ))}
        </div>
      </Collapsible>
    </div>
  );
}

/** A panel's parked leaves folded to one trailing `N parked · expand` row. */
function FoldedParked({
  tasks,
  onOpenNode,
  offline,
}: {
  tasks: WireTreeNode[];
  onOpenNode: (id: string) => void;
  offline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-line last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
        }}
        className="flex w-full items-center gap-2.5 px-4 py-[9px] text-left opacity-60 focus-visible:outline-2 focus-visible:outline-accent"
      >
        <StatusDot status="parked" />
        <span className="text-[13px] text-ink-faint">
          {String(tasks.length)} parked · {open ? 'collapse' : 'expand'}
        </span>
        <span
          aria-hidden
          className={cn('ml-auto text-ink-ghost transition-transform', open && 'rotate-180')}
        >
          ⌄
        </span>
      </button>
      <Collapsible open={open}>
        <div className="border-t border-line">
          {tasks.map((t) => (
            <LeafRow key={t.id} node={t} onOpenNode={onOpenNode} offline={offline} />
          ))}
        </div>
      </Collapsible>
    </div>
  );
}
