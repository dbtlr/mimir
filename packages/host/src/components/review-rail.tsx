import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { WireReviewProject, WireReviewReport } from '../api/types';
import { cn } from '../lib/cn';
import { nodeLink, seedLink } from '../lib/record-url';
import { ago, relativeTime } from '../lib/time';
import { useRowFocusHandoff } from '../lib/use-row-focus-handoff';
import { capDay } from '../lib/work-page';
import { BrowserRow } from './browser-list';
import { RailSection } from './record-layout';
import { SeedKindChip } from './seed-kind-chip';
import { SeedTriageActions } from './seed-triage-actions';
import { RowTail, StartAction } from './work-rows';

/*
 * The review page's rail (ADR 0013, MMR-503 refinement): the project health
 * strip, then _When you have a minute_ — what can wait, in four groups.
 */

/** Rows a spare-minute group shows before its "N more" control. */
const GROUP_CAP = 5;

const ROW_LINK =
  'rounded-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent';

/** A strip count: the number with its noun for a screen reader, or a dash at zero. */
function StripCount({
  n,
  noun,
  className,
}: {
  n: number;
  noun: (n: number) => string;
  className: string;
}) {
  if (n === 0) {
    return (
      <span aria-hidden className="text-right font-mono text-mono-id text-ink-ghost">
        —
      </span>
    );
  }
  return (
    <span
      title={noun(n)}
      className={cn('text-right font-mono text-mono-id tabular-nums', className)}
    >
      {n}
      <span className="sr-only"> {noun(n)}</span>
    </span>
  );
}

// The rail is narrow: the three count columns stay tight (two tabular digits
// at the count size) so the name column gets the width.
const STRIP_COLUMNS =
  'grid grid-cols-[2.75rem_minmax(0,1fr)_1.75rem_1.75rem_1.75rem] items-baseline gap-x-1.5';

/**
 * One row per active project in the report's order (pinned first, then the
 * most recent activity): its decisions in the attention hue, its open tasks
 * ("live"), and the tasks going cold. A row opens the project's work page.
 */
function HealthStrip({ projects }: { projects: readonly WireReviewProject[] }) {
  // With every project archived there is nothing to list, and headers alone mislead.
  if (projects.length === 0) {
    return null;
  }
  return (
    <RailSection label="Projects" count={projects.length}>
      <div aria-hidden className={cn(STRIP_COLUMNS, 'px-1 font-mono text-micro text-ink-faint')}>
        <span />
        <span />
        <span className="text-right">you</span>
        <span className="text-right">live</span>
        <span className="text-right">cold</span>
      </div>
      <ul aria-label="Project health" className="-mt-1 flex flex-col">
        {projects.map((p) => (
          <li key={p.key}>
            <Link
              to="/p/$key"
              params={{ key: p.key }}
              className={cn(
                ROW_LINK,
                STRIP_COLUMNS,
                'min-h-9 rounded-md px-1 py-1 hover:bg-well-850 max-md:min-h-11',
              )}
            >
              <span className="font-mono text-mono-id text-accent-foreground">{p.key}</span>
              <span title={p.name} className="min-w-0 truncate text-meta text-ink">
                {p.name}
              </span>
              <StripCount
                n={p.decisions}
                noun={(n) => (n === 1 ? '1 decision' : `${String(n)} decisions`)}
                className="font-semibold text-attention-foreground"
              />
              <StripCount
                n={p.live}
                noun={(n) => `${String(n)} live`}
                className="text-status-in-progress-foreground"
              />
              <StripCount
                n={p.going_cold}
                noun={(n) => `${String(n)} cold`}
                className="text-cold"
              />
            </Link>
          </li>
        ))}
      </ul>
    </RailSection>
  );
}

/** One spare-minute group: its heading with a count over its rows. */
function MinuteGroup({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className="flex flex-col">
      <h3 className="microlabel mb-0.5 text-ink-faint">
        {label} · {count}
      </h3>
      {children}
    </section>
  );
}

/**
 * A group's first rows and an in-place "N more" for the rest. The control
 * unmounts as it is pressed, so focus goes to the first row it revealed.
 */
function CappedRows<T>({
  rows,
  noun,
  children,
}: {
  rows: readonly T[];
  /** What the hidden rows are, for the control's name: "Show 2 more runnable". */
  noun: string;
  children: (row: T) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const justExpanded = useRef(false);
  const { shown, hidden } = capDay(rows, expanded, GROUP_CAP);
  useEffect(() => {
    if (expanded && justExpanded.current) {
      justExpanded.current = false;
      listRef.current?.querySelectorAll<HTMLElement>('[data-row-id] a')[GROUP_CAP]?.focus();
    }
  }, [expanded]);
  return (
    <div ref={listRef}>
      {shown.map(children)}
      {hidden > 0 && (
        <button
          type="button"
          aria-label={`Show ${String(hidden)} more ${noun}`}
          onClick={() => {
            justExpanded.current = true;
            setExpanded(true);
          }}
          className={cn(
            ROW_LINK,
            'ml-1 px-1 py-1 text-xs text-accent-foreground hover:text-accent',
          )}
        >
          {hidden} more
        </button>
      )}
    </div>
  );
}

/** Per-project `doctor` findings, each row linking to that project's record health. */
function FindingsRows({ triage }: { triage: WireReviewReport['triage'] }) {
  return (
    <ul>
      {triage
        .filter((group) => group.findings > 0)
        .map((group) => (
          <li key={group.project.key}>
            <Link
              to="/doctor"
              search={{ project: group.project.key }}
              className={cn(
                ROW_LINK,
                'flex min-h-9 items-baseline gap-2 rounded-md px-1 py-1 hover:bg-well-850 max-md:min-h-11',
              )}
            >
              <span className="font-mono text-mono-id text-accent-foreground">
                {group.project.key}
              </span>
              <span className="min-w-0 flex-1 text-meta text-ink">
                {group.findings} {group.findings === 1 ? 'finding' : 'findings'}
              </span>
              <span className="text-tag text-ink-faint">Doctor →</span>
            </Link>
          </li>
        ))}
    </ul>
  );
}

/**
 * What can wait for a spare minute, in four groups: runnable now, to triage,
 * going cold, and `doctor` findings. A group with no rows is absent; with all
 * four empty a quiet line says so. Start and the seed verbs act in place, and
 * share one focus handoff: a row that leaves hands focus to the next row in
 * the section (the next group's first, when its group ran out), else to the
 * section's heading, which stays whatever the groups hold.
 */
function MinuteSection({ report, offline }: { report: WireReviewReport; offline: boolean }) {
  const seeds = report.triage.flatMap((group) => group.seeds);
  const findings = report.triage.filter((group) => group.findings > 0);
  const total = report.runnable.length + seeds.length + report.going_cold.length + findings.length;
  const { handoff, headingRef } = useRowFocusHandoff([
    ...report.runnable.map((row) => row.id),
    ...seeds.map((seed) => seed.id),
  ]);
  return (
    <RailSection
      label="When you have a minute"
      count={total > 0 ? total : undefined}
      headingRef={headingRef}
    >
      {total === 0 ? (
        <p className="text-xs text-ink-faint">Nothing is waiting for a spare minute.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {report.runnable.length > 0 && (
            <MinuteGroup label="Runnable now" count={report.runnable.length}>
              <CappedRows rows={report.runnable} noun="runnable">
                {(row) => (
                  <BrowserRow
                    key={row.id}
                    to={nodeLink(row.id)}
                    id={row.id}
                    title={row.title}
                    afterTitle={<RowTail row={row} />}
                    actions={<StartAction id={row.id} offline={offline} handoff={handoff} />}
                    actionsBelow
                  />
                )}
              </CappedRows>
            </MinuteGroup>
          )}
          {seeds.length > 0 && (
            <MinuteGroup label="To triage" count={seeds.length}>
              <CappedRows rows={seeds} noun="to triage">
                {(seed) => (
                  <BrowserRow
                    key={seed.id}
                    to={seedLink(seed.id)}
                    id={seed.id}
                    title={seed.title}
                    beforeTitle={<SeedKindChip kind={seed.kind} />}
                    meta={`filed ${ago(seed.created_at)}`}
                    actions={<SeedTriageActions seed={seed} offline={offline} handoff={handoff} />}
                    actionsBelow
                  />
                )}
              </CappedRows>
            </MinuteGroup>
          )}
          {report.going_cold.length > 0 && (
            <MinuteGroup label="Going cold" count={report.going_cold.length}>
              <CappedRows rows={report.going_cold} noun="going cold">
                {(row) => (
                  <BrowserRow
                    key={row.id}
                    to={nodeLink(row.id)}
                    id={row.id}
                    title={row.title}
                    meta={<span>⧗ {relativeTime(row.updated_at)} quiet</span>}
                  />
                )}
              </CappedRows>
            </MinuteGroup>
          )}
          {findings.length > 0 && (
            <MinuteGroup label="Findings" count={findings.length}>
              <FindingsRows triage={report.triage} />
            </MinuteGroup>
          )}
        </div>
      )}
    </RailSection>
  );
}

/** The review page's rail: the project health strip, then what can wait. */
export function ReviewRail({ report, offline }: { report: WireReviewReport; offline: boolean }) {
  return (
    <>
      <HealthStrip projects={report.projects} />
      <MinuteSection report={report} offline={offline} />
    </>
  );
}
