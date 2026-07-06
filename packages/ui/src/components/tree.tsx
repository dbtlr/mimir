import type { StatusWord } from '@mimir/contract';

import type { WireTreeNode } from '../api/types';
import { cn } from '../lib/cn';
import { STATUS_META } from '../lib/status';
import { DistributionBar } from './distribution-bar';
import { OpenEndedBadge, PriorityBadge, SizeBadge, StaleBadge } from './signal-badges';
import { StatusDot } from './status-dot';

/**
 * One-letter status marker for the mobile tree scan, where the full status word
 * is hidden for space and the 7px dot alone is hard to read on the dark well.
 * Distinct letters (no two collide), redundant with the dot's color.
 */
const STATUS_LETTER: Record<StatusWord, string> = {
  abandoned: 'X',
  awaiting: 'A',
  blocked: 'B',
  done: 'D',
  in_progress: 'P',
  new: 'N',
  parked: 'K',
  ready: 'R',
  under_review: 'V',
};

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
    return <p className="px-3 py-6 text-center text-xs text-ink-faint">An empty project.</p>;
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
  const container = node.type !== 'task';
  const meta = STATUS_META[node.status];
  const row = (
    <button
      type="button"
      onClick={() => {
        onOpenNode(node.id);
      }}
      className={cn(
        'flex w-full items-center gap-2 rounded-sm border border-transparent px-2 py-1.5 text-left',
        'transition-colors hover:border-line hover:bg-well-850 focus-visible:outline-2 focus-visible:outline-accent',
      )}
    >
      <StatusDot status={node.status} />
      <span className={cn('shrink-0 font-mono text-sm font-semibold sm:hidden', meta.text)}>
        {STATUS_LETTER[node.status]}
      </span>
      <span className="shrink-0 font-mono text-xs whitespace-nowrap text-ink-dim md:text-3xs">
        {node.id}
      </span>
      <span
        className={cn(
          // leading-tight pins a consistent rhythm across the container (text-base,
          // which carries Tailwind's looser default leading) and leaf branches when
          // the title wraps to two lines on mobile (MMR-107).
          'min-w-0 line-clamp-2 leading-tight md:truncate md:text-xs',
          container
            ? 'text-base font-semibold text-ink-bright'
            : 'text-md text-ink-bright md:font-normal md:text-ink',
        )}
      >
        {node.title}
      </span>
      <span className={cn('microlabel hidden sm:inline', meta.text)}>{meta.label}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1 md:ml-0">
        {node.open_ended === true && <OpenEndedBadge />}
        {node.verdicts?.stale === true && <StaleBadge />}
        {node.priority != null && <PriorityBadge priority={node.priority} />}
        {node.size != null && <SizeBadge size={node.size} />}
      </span>
      {container && (
        <DistributionBar
          distribution={node.distribution ?? {}}
          className="ml-auto hidden shrink-0 sm:flex sm:w-36"
        />
      )}
    </button>
  );

  if (!container) {
    return row;
  }
  return (
    <details open className="group">
      <summary className="flex cursor-pointer list-none items-center [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden
          className="flex h-7 w-7 shrink-0 items-center justify-center text-ink-dim transition-transform group-open:rotate-90 md:h-5 md:w-5"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
            <path
              d="m9 6 6 6-6 6"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="min-w-0 flex-1">{row}</span>
      </summary>
      <div className="mt-1 ml-[14px] flex flex-col gap-1 border-l border-line-bright pl-3 md:ml-[10px] md:border-line">
        {node.children.map((child) => (
          <TreeNode key={child.id} node={child} depth={depth + 1} onOpenNode={onOpenNode} />
        ))}
      </div>
    </details>
  );
}
