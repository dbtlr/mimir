import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import { annotationsQuery, nodeQuery } from '../api/node-queries';
import { treeQuery } from '../api/shell-queries';
import { projectKeyOf } from '../api/types';
import { reviewQuery } from '../api/view-queries';
import type { NeedsYouTask, ReviewReport } from '../api/view-queries';
import { cn } from '../lib/cn';
import { nodeLink } from '../lib/record-url';
import type { RowFocusHandoff } from '../lib/use-row-focus-handoff';
import { verdictSummary } from '../lib/verdict';
import { Crumbs } from './crumbs';
import { LinkifiedText } from './linkified-text';
import { MarkdownBody } from './markdown-body';
import { ExternalRef } from './node-record';
import { RecordPending } from './record-layout';
import { ActionButton, actionButtonVariants } from './ui/action-button';
import { needsYouActions } from './work-rows';

/*
 * `/?mode=focus` — the review page's focus queue (ADR 0013, MMR-476
 * refinement): one decision at a time, in ADR 0019's queue order. The list is
 * fixed when the queue opens, from a fresh read rather than a cached one, so a
 * decision that arrives later waits for the next pass. The queue only moves
 * forward: a decision settled anywhere — here, by its action, or elsewhere —
 * drops out of the live review read and the queue moves past it, and Skip
 * moves past one without acting, leaving it on the page. A decision behind
 * the queue stays behind it, even when it returns. When nothing is left the
 * queue returns to `/`.
 */

/** Why a decision needs the operator, in the card's words. */
const REASON: Record<NeedsYouTask['reason'], string> = {
  blocked: 'Blocked · yours',
  needs_answers: 'Needs answers',
  under_review: 'In review',
};

/** The card's actions settle the decision itself, so there is no row to hand focus on from. */
const NO_HANDOFF: RowFocusHandoff = { arm: () => {}, disarm: () => {} };

/** Every decision on the live review read, by task id. */
function liveDecisions(report: ReviewReport): Map<string, NeedsYouTask> {
  return new Map(report.decisions.flatMap((group) => group.rows.map((row) => [row.task.id, row])));
}

export function FocusQueue({ offline }: { offline: boolean }) {
  // Its own observer, so opening the queue refetches a read gone stale.
  const review = useQuery(reviewQuery());
  const [fixed, setFixed] = useState<readonly string[] | null>(null);
  // The queue's place in the fixed list; nothing before it comes back.
  const [cursor, setCursor] = useState(0);
  const navigate = useNavigate();
  const report = review.data;
  // A read that cannot refresh (failed, or paused offline) is the best there is.
  const settled = !review.isStale || review.isError || review.isPaused;
  if (fixed === null && report !== undefined && settled) {
    setFixed(report.queue);
  }
  const live = report === undefined ? new Map<string, NeedsYouTask>() : liveDecisions(report);
  const index = fixed?.findIndex((id, i) => i >= cursor && live.has(id)) ?? -1;
  if (index > cursor) {
    setCursor(index);
  }
  const exhausted = fixed !== null && index === -1;

  useEffect(() => {
    if (exhausted) {
      void navigate({ replace: true, search: {}, to: '/' });
    }
  }, [exhausted, navigate]);
  if (fixed === null || index === -1) {
    return exhausted ? null : <RecordPending unreachable={false} />;
  }

  const current = live.get(fixed[index]!)!;
  const nextId = fixed.slice(index + 1).find((id) => live.has(id));
  const next = nextId === undefined ? undefined : live.get(nextId);
  const position = index + 1;
  return (
    <main className="mx-auto flex w-full max-w-[720px] flex-1 flex-col gap-4 p-5 max-md:px-3.5">
      <h1 className="sr-only">Work through these</h1>
      <div className="flex items-center gap-3">
        <Link
          to="/"
          className="rounded-sm text-meta text-accent-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent"
        >
          ← Back to the list
        </Link>
        <span className="ml-auto font-mono text-mono-id font-semibold text-ink-dim">
          {position} of {fixed.length}
        </span>
        <span aria-hidden className="h-1 w-24 rounded-sm bg-well-800 md:w-36">
          <span
            className="block h-full rounded-sm bg-attention"
            style={{ width: `${String((position / fixed.length) * 100)}%` }}
          />
        </span>
      </div>
      <FocusCard
        key={current.task.id}
        row={current}
        offline={offline}
        onSkip={() => setCursor(index + 1)}
      />
      {next !== undefined && (
        <section aria-label="Up next" className="flex flex-col gap-1">
          <h2 className="microlabel text-ink-faint">Up next</h2>
          <p className="flex flex-wrap items-baseline gap-x-2 text-meta text-ink-dim">
            <span className="font-mono text-mono-id text-accent-foreground">
              {projectKeyOf(next.task.id)}
            </span>
            <span className="microlabel text-attention-foreground">{REASON[next.reason]}</span>
            <span className="font-mono text-mono-id">{next.task.id}</span>
            <span className="min-w-0 truncate">{next.task.title}</span>
          </p>
        </section>
      )}
    </main>
  );
}

/**
 * One decision with what the operator needs to settle it: its path and
 * description from the task's own record, then the question, the submitted
 * work, or what the block waits on, then the row's actions, Skip, and a link
 * to the task page. The card mounts per decision, so when it takes the place
 * of one that left, focus lands on its first action.
 */
function FocusCard({
  row,
  offline,
  onSkip,
}: {
  row: NeedsYouTask;
  offline: boolean;
  onSkip: () => void;
}) {
  const titleId = useId();
  const actionsRef = useRef<HTMLDivElement>(null);
  const projectKey = projectKeyOf(row.task.id);
  const node = useQuery(nodeQuery(row.task.id));
  const annotations = useQuery({
    ...annotationsQuery(row.task.id),
    enabled: row.reason === 'under_review',
  });
  const tree = useQuery({ ...treeQuery(projectKey), refetchInterval: false });

  useLayoutEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) {
      actionsRef.current
        ?.querySelector<HTMLElement>('button:not(:disabled), a')
        ?.focus({ preventScroll: true });
    }
  }, []);

  const description = node.data?.description?.trim();
  const submitted =
    row.reason === 'under_review'
      ? verdictSummary(node.data?.history, annotations.data?.items)
      : undefined;
  const holdReason = row.reason === 'blocked' ? row.task.holdReason?.trim() : undefined;
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-lg border border-line-bright border-l-3 border-l-attention bg-well-850 px-5 py-4 max-md:px-3.5"
    >
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-mono-id text-accent-foreground">{projectKey}</span>
        <span className="microlabel text-attention-foreground">{REASON[row.reason]}</span>
        <span className="font-mono text-mono-id text-ink-dim">{row.task.id}</span>
      </p>
      <h2 id={titleId} className="text-dossier font-semibold text-ink-bright">
        {row.task.title}
      </h2>
      <Crumbs projectKey={projectKey} tree={tree.data} nodeId={row.task.id} />
      {row.question !== null && (
        <Context label="Latest question" className="border-attention">
          <span className="whitespace-pre-line text-attention-foreground">{row.question}</span>
        </Context>
      )}
      {submitted !== undefined && (
        <Context label="Submitted" className="border-attention">
          <span className="whitespace-pre-line text-ink">{submitted}</span>
        </Context>
      )}
      {node.data?.external_ref != null && row.reason === 'under_review' && (
        <ExternalRef value={node.data.external_ref} />
      )}
      {holdReason !== undefined && holdReason !== '' && (
        <Context label="Waiting on" className="border-attention">
          <span className="whitespace-pre-line text-ink">
            <LinkifiedText>{holdReason}</LinkifiedText>
          </span>
        </Context>
      )}
      {description !== undefined && description !== '' && (
        <MarkdownBody breaks className="max-w-none">
          {description}
        </MarkdownBody>
      )}
      <div
        ref={actionsRef}
        role="group"
        aria-label={`Actions for ${row.task.id}`}
        className="flex flex-wrap gap-2"
      >
        {needsYouActions(row, offline, NO_HANDOFF)}
        <ActionButton size="sm" variant="outline" className="max-md:min-h-11" onClick={onSkip}>
          Skip
        </ActionButton>
        <Link
          {...nodeLink(row.task.id)}
          className={cn(
            actionButtonVariants({ size: 'sm', variant: 'outline' }),
            'max-md:min-h-11',
          )}
        >
          Open task page
        </Link>
      </div>
    </section>
  );
}

/** A labelled block of the context a decision turns on. */
function Context({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('rounded-sm border-l-2 bg-well-800 px-3 py-2 text-meta', className)}>
      <span className="microlabel block text-ink-faint">{label}</span>
      {children}
    </div>
  );
}
