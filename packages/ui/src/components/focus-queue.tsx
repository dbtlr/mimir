import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import { annotationsQuery, nodeQuery, treeQuery } from '../api/queries';
import { projectKeyOf } from '../api/types';
import type { WireReviewReport, WireWorkNeedsYou } from '../api/types';
import { cn } from '../lib/cn';
import { nodeLink } from '../lib/record-url';
import type { RowFocusHandoff } from '../lib/use-row-focus-handoff';
import { verdictSummary } from '../lib/verdict';
import { MarkdownBody } from './markdown-body';
import { ExternalRef } from './node-record';
import { ActionButton, actionButtonVariants } from './ui/action-button';
import { Crumbs } from './work-page';
import { needsYouActions } from './work-rows';

/*
 * `/?mode=focus` — the review page's focus queue (ADR 0013, MMR-476
 * refinement): one decision at a time, in ADR 0019's queue order. The list is
 * fixed when the queue opens, so a decision that arrives later waits for the
 * next pass. A decision settled anywhere — here, by its action, or elsewhere —
 * drops out of the live review read and the queue moves past it; Skip moves
 * past one without acting and leaves it on the page. When nothing is left the
 * queue returns to `/`.
 */

/** Why a decision needs the operator, in the card's words. */
const REASON: Record<WireWorkNeedsYou['reason'], string> = {
  blocked: 'Blocked · yours',
  needs_answers: 'Needs answers',
  under_review: 'In review',
};

/** The card's actions settle the decision itself, so there is no row to hand focus on from. */
const NO_HANDOFF: RowFocusHandoff = { arm: () => {}, disarm: () => {} };

/** Every decision on the live review read, by task id. */
function liveDecisions(report: WireReviewReport): Map<string, WireWorkNeedsYou> {
  return new Map(report.decisions.flatMap((group) => group.rows.map((row) => [row.id, row])));
}

/** The fixed list's decisions not yet passed: still live, and not skipped. */
function remainingOf(
  fixed: readonly string[],
  live: ReadonlyMap<string, WireWorkNeedsYou>,
  skipped: ReadonlySet<string>,
): WireWorkNeedsYou[] {
  return fixed.flatMap((id) => {
    const row = live.get(id);
    return row === undefined || skipped.has(id) ? [] : [row];
  });
}

export function FocusQueue({ report, offline }: { report: WireReviewReport; offline: boolean }) {
  const [fixed] = useState(() => report.queue);
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const navigate = useNavigate();
  const [current, next] = remainingOf(fixed, liveDecisions(report), skipped);

  useEffect(() => {
    if (current === undefined) {
      void navigate({ replace: true, search: {}, to: '/' });
    }
  }, [current, navigate]);
  if (current === undefined) {
    return null;
  }

  const position = fixed.indexOf(current.id) + 1;
  return (
    <main className="mx-auto flex w-full max-w-[720px] flex-1 flex-col gap-4 p-5 max-md:px-3.5">
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
        key={current.id}
        row={current}
        offline={offline}
        onSkip={() => setSkipped(new Set([...skipped, current.id]))}
      />
      {next !== undefined && (
        <section aria-label="Up next" className="flex flex-col gap-1">
          <h2 className="microlabel text-ink-faint">Up next</h2>
          <p className="flex flex-wrap items-baseline gap-x-2 text-meta text-ink-dim">
            <span className="font-mono text-mono-id text-accent-foreground">
              {projectKeyOf(next.id)}
            </span>
            <span className="microlabel text-attention-foreground">{REASON[next.reason]}</span>
            <span className="font-mono text-mono-id">{next.id}</span>
            <span className="min-w-0 truncate">{next.title}</span>
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
  row: WireWorkNeedsYou;
  offline: boolean;
  onSkip: () => void;
}) {
  const titleId = useId();
  const actionsRef = useRef<HTMLDivElement>(null);
  const projectKey = projectKeyOf(row.id);
  const node = useQuery(nodeQuery(row.id));
  const annotations = useQuery({
    ...annotationsQuery(row.id),
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
  const holdReason = row.reason === 'blocked' ? row.hold_reason?.trim() : undefined;
  return (
    <article
      aria-label={`Decision ${row.id}`}
      aria-describedby={titleId}
      className="flex flex-col gap-3 rounded-lg border border-line-bright border-l-3 border-l-attention bg-well-850 px-5 py-4 max-md:px-3.5"
    >
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-mono-id text-accent-foreground">{projectKey}</span>
        <span className="microlabel text-attention-foreground">{REASON[row.reason]}</span>
        <span className="font-mono text-mono-id text-ink-dim">{row.id}</span>
      </p>
      <h2 id={titleId} className="text-dossier font-semibold text-ink-bright">
        {row.title}
      </h2>
      <Crumbs projectKey={projectKey} tree={tree.data} nodeId={row.id} />
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
          <span className="whitespace-pre-line text-ink">{holdReason}</span>
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
        aria-label={`Actions for ${row.id}`}
        className="flex flex-wrap gap-2"
      >
        {needsYouActions(row, offline, NO_HANDOFF)}
        <ActionButton size="sm" variant="outline" className="max-md:min-h-11" onClick={onSkip}>
          Skip
        </ActionButton>
        <Link
          {...nodeLink(row.id)}
          className={cn(
            actionButtonVariants({ size: 'sm', variant: 'outline' }),
            'max-md:min-h-11',
          )}
        >
          Open task page
        </Link>
      </div>
    </article>
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
