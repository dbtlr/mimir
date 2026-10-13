import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';

import { archivedProjectsQuery, reviewQuery } from '../api/queries';
import type { WireNode, WireReviewProject, WireReviewReport, WireReviewTriage } from '../api/types';
import { ArchivedShelf } from '../components/archived-shelf';
import { BrowserGroup, BrowserRow } from '../components/browser-list';
import { NewProjectSheet } from '../components/new-project-sheet';
import { OfflineBanner } from '../components/offline-banner';
import { RailSection, RecordLayout, RecordPending } from '../components/record-layout';
import { SeedKindChip } from '../components/seed-kind-chip';
import { ActionButton } from '../components/ui/action-button';
import { NeedsYouRow } from '../components/work-rows';
import { cn } from '../lib/cn';
import { connectivity } from '../lib/connectivity';
import { nodeLink, seedLink } from '../lib/record-url';
import { ago, relativeTime } from '../lib/time';

/*
 * `/` — the review page (ADR 0013 and ADR 0019, MMR-476 refinements): what
 * needs the operator across every active project. Decide lists the decisions
 * grouped by project; Triage tallies what can wait for a spare minute; the
 * rail is the project list. One read (`/api/review`) feeds all three, and the
 * top-bar alert reads the same entry, so their counts never disagree.
 */

/** `1 decision` / `2 decisions` — a count with its noun, singular at one. */
const counted = (n: number, one: string, many = `${one}s`): string =>
  `${String(n)} ${n === 1 ? one : many}`;

const PROJECT_LINK =
  'rounded-sm focus-visible:outline-2 focus-visible:outline-accent transition-colors';

function ReviewHead({ count }: { count: number }) {
  return (
    <header className="flex flex-col gap-1">
      <h1 className="text-header font-bold tracking-[-0.01em] text-ink-bright">
        {count > 0 ? (
          <>
            Needs you <span className="font-normal text-ink-faint">{count}</span>
          </>
        ) : (
          'Nothing needs you'
        )}
      </h1>
      <p className="text-meta text-ink-dim">
        Decisions block agents, so they lead. Triage can wait for a spare minute.
      </p>
    </header>
  );
}

/** The project a group of rows belongs to, opening its work page. */
function ProjectHeading({ project }: { project: { key: string; name: string } }) {
  return (
    <h3 className="mb-1">
      <Link
        to="/p/$key"
        params={{ key: project.key }}
        className={cn(PROJECT_LINK, 'inline-flex items-baseline gap-2 hover:text-ink-bright')}
      >
        <span className="font-mono text-mono-id text-accent-foreground">{project.key}</span>
        <span className="text-meta font-semibold text-ink">{project.name}</span>
      </Link>
    </h3>
  );
}

/** Decide's all-clear: nothing waits, so name the work in flight and the last finish. */
function AllClear({
  inFlight,
  last,
}: {
  inFlight: number;
  last: WireReviewReport['last_finished'];
}) {
  return (
    <p className="px-1 py-2 text-xs text-ink-faint">
      <strong className="font-semibold text-ink-dim">
        No verdicts, blocks, or questions are waiting.
      </strong>{' '}
      {inFlight > 0
        ? `Agents are working on ${counted(inFlight, 'task')}.`
        : 'No task is in progress.'}
      {last !== null && (
        <>
          {' '}
          Last finished: <span className="font-mono">{last.id}</span>{' '}
          <Link {...nodeLink(last.id)} className="text-ink-dim underline-offset-2 hover:underline">
            {last.title}
          </Link>
          {last.status === 'abandoned' && ' (abandoned)'}, {ago(last.finished_at)}.
        </>
      )}
    </p>
  );
}

function DecideSection({ report }: { report: WireReviewReport }) {
  const count = report.queue.length;
  const inFlight = report.projects.reduce((n, p) => n + p.in_flight, 0);
  return (
    <BrowserGroup
      label="Decide"
      count={count > 0 ? count : undefined}
      hint="Only your action moves these."
      labelClassName="text-attention-foreground"
    >
      {report.decisions.length === 0 ? (
        <AllClear inFlight={inFlight} last={report.last_finished} />
      ) : (
        <div className="flex flex-col gap-4">
          {report.decisions.map((group) => (
            <section key={group.project.key} aria-label={group.project.name}>
              <ProjectHeading project={group.project} />
              {group.rows.map((row) => (
                <NeedsYouRow key={row.id} row={row} />
              ))}
            </section>
          ))}
        </div>
      )}
    </BrowserGroup>
  );
}

/** A triage cell at zero: the count is absent, not nought. */
const NONE = <span className="text-ink-ghost">—</span>;

const COUNT_LINK =
  'rounded-sm font-mono underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent';

/** One project's triage row, which opens in place to list its untriaged seeds. */
function TriageRow({ group }: { group: WireReviewTriage }) {
  const [open, setOpen] = useState(false);
  const seedsId = useId();
  const { project, seeds } = group;
  const [oldest] = seeds;
  const label = (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="font-mono text-mono-id text-accent-foreground">{project.key}</span>
      <span className="min-w-0 text-meta text-ink">{project.name}</span>
    </span>
  );
  return (
    <>
      <tr className="border-b border-line">
        <th scope="row" className="py-1.5 pr-3 text-left font-normal">
          {seeds.length > 0 ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={open ? seedsId : undefined}
              onClick={() => setOpen((o) => !o)}
              className={cn(PROJECT_LINK, 'flex min-h-9 items-center gap-2 text-left')}
            >
              <span aria-hidden className="w-2 text-micro text-ink-faint">
                {open ? '⌄' : '›'}
              </span>
              {label}
            </button>
          ) : (
            <span className="flex min-h-9 items-center gap-2">
              <span aria-hidden className="w-2" />
              {label}
            </span>
          )}
        </th>
        <td className="px-1.5 text-right md:px-2 font-mono text-mono-id text-ink-dim">
          {seeds.length === 0 ? NONE : seeds.length}
        </td>
        <td className="px-1.5 text-right md:px-2 font-mono text-mono-id text-ink-faint">
          {oldest === undefined ? NONE : relativeTime(oldest.created_at)}
        </td>
        <td className="px-1.5 text-right md:px-2 text-mono-id text-cold">
          {group.going_cold === 0 ? (
            NONE
          ) : (
            <Link to="/p/$key" params={{ key: project.key }} className={COUNT_LINK}>
              {group.going_cold}
            </Link>
          )}
        </td>
        <td className="pl-1.5 text-right md:pl-2 text-mono-id text-status-in-progress-foreground">
          {group.findings === 0 ? (
            NONE
          ) : (
            <Link to="/doctor" search={{ project: project.key }} className={COUNT_LINK}>
              {group.findings}
            </Link>
          )}
        </td>
      </tr>
      {open && (
        <tr id={seedsId} className="border-b border-line">
          <td colSpan={5} className="pb-2 pl-4">
            <section aria-label={`Untriaged seeds in ${project.name}`}>
              {seeds.map((seed) => (
                <BrowserRow
                  key={seed.id}
                  to={seedLink(seed.id)}
                  id={seed.id}
                  title={seed.title}
                  beforeTitle={<SeedKindChip kind={seed.kind} />}
                  lede={seed.lede}
                  meta={`filed ${ago(seed.created_at)}`}
                />
              ))}
            </section>
          </td>
        </tr>
      )}
    </>
  );
}

/** Triage's heading hint: the cross-project totals that are not zero. */
function triageSummary(triage: readonly WireReviewTriage[]): string {
  const seeds = triage.reduce((n, t) => n + t.seeds.length, 0);
  const cold = triage.reduce((n, t) => n + t.going_cold, 0);
  const findings = triage.reduce((n, t) => n + t.findings, 0);
  return [
    seeds > 0 && counted(seeds, 'seed'),
    cold > 0 && `${String(cold)} going cold`,
    findings > 0 && counted(findings, 'finding'),
  ]
    .filter((part) => part !== false)
    .join(' · ');
}

const COLUMN =
  'px-1.5 pb-1.5 text-right font-mono text-micro font-semibold tracking-[0.06em] whitespace-nowrap uppercase md:px-2 md:tracking-[0.13em]';

/** Untriaged seeds, going cold, and findings per project: nothing here stops an agent. */
function TriageSection({ triage }: { triage: readonly WireReviewTriage[] }) {
  if (triage.length === 0) {
    return null;
  }
  return (
    <BrowserGroup label="Triage when you have a minute" hint={triageSummary(triage)}>
      <div className="overflow-x-auto">
        <table aria-label="Triage" className="w-full border-collapse">
          <thead className="text-ink-faint">
            <tr className="border-b border-line">
              <th scope="col" className={cn(COLUMN, 'pl-0 text-left')}>
                Project
              </th>
              <th scope="col" className={COLUMN}>
                Seeds
              </th>
              <th scope="col" className={COLUMN}>
                Oldest
              </th>
              <th scope="col" className={COLUMN}>
                {/* A phone has no width for the full label. */}
                <span className="md:hidden">Cold</span>
                <span className="max-md:hidden">Going cold</span>
              </th>
              <th scope="col" className={cn(COLUMN, 'pr-0')}>
                Findings
              </th>
            </tr>
          </thead>
          <tbody>
            {triage.map((group) => (
              <TriageRow key={group.project.key} group={group} />
            ))}
          </tbody>
        </table>
      </div>
    </BrowserGroup>
  );
}

/** A count in the project list, with its noun for a screen reader and a hover title. */
function ListCount({
  n,
  one,
  many,
  className,
}: {
  n: number;
  one: string;
  many?: string;
  className: string;
}) {
  const words = counted(n, one, many);
  return (
    <span title={words} className={cn('font-mono text-mono-id', className)}>
      {n}
      <span className="sr-only">{words.slice(String(n).length)}</span>
    </span>
  );
}

/**
 * The rail: every active project in the review order, each opening its work
 * page with its decisions, triage, and work in flight; then the archived
 * shelf and the New project action.
 */
function ProjectList({
  projects,
  archived,
  offline,
  onCreate,
}: {
  projects: readonly WireReviewProject[];
  archived: WireNode[];
  offline: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <ul aria-label="Projects" className="flex flex-col">
        {projects.map((p) => (
          <li key={p.key}>
            <Link
              to="/p/$key"
              params={{ key: p.key }}
              className={cn(
                PROJECT_LINK,
                'flex min-h-9 items-baseline gap-2 px-1 py-1 hover:bg-well-850',
              )}
            >
              <span className="w-12 shrink-0 font-mono text-mono-id text-accent-foreground">
                {p.key}
              </span>
              <span className="min-w-0 flex-1 truncate text-meta text-ink">{p.name}</span>
              {p.in_flight > 0 && (
                <span className="shrink-0 text-micro text-status-in-progress-foreground">
                  {p.in_flight} live
                </span>
              )}
              {p.triage > 0 && (
                <ListCount
                  n={p.triage}
                  one="to triage"
                  many="to triage"
                  className="text-ink-faint"
                />
              )}
              {p.decisions > 0 && (
                <ListCount
                  n={p.decisions}
                  one="decision"
                  className="font-semibold text-attention-foreground"
                />
              )}
            </Link>
          </li>
        ))}
      </ul>
      <ArchivedShelf projects={archived} offline={offline} />
      <ActionButton className="self-start px-3.5 py-1.5" disabled={offline} onClick={onCreate}>
        + New project
      </ActionButton>
    </div>
  );
}

export function ReviewPage() {
  const [creating, setCreating] = useState(false);
  const review = useQuery(reviewQuery);
  const archived = useQuery(archivedProjectsQuery);
  const conn = connectivity([review, archived]);
  const archivedProjects = archived.data?.items ?? [];
  const sheet = <NewProjectSheet open={creating} onOpenChange={setCreating} />;

  if (review.data === undefined) {
    return (
      <>
        <OfflineBanner {...conn} />
        <RecordPending unreachable={review.isError} />
      </>
    );
  }
  const report = review.data;

  if (report.projects.length === 0 && archivedProjects.length === 0) {
    // A fresh store's one useful action is creating a project.
    return (
      <>
        <OfflineBanner {...conn} />
        <main className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col items-start gap-3 p-5">
          <p className="text-xs text-ink-dim">No projects yet.</p>
          <ActionButton
            className="px-3.5 py-1.5"
            disabled={conn.offline}
            onClick={() => setCreating(true)}
          >
            + New project
          </ActionButton>
        </main>
        {sheet}
      </>
    );
  }

  const projectList = (
    <ProjectList
      projects={report.projects}
      archived={archivedProjects}
      offline={conn.offline}
      onCreate={() => setCreating(true)}
    />
  );
  return (
    <>
      <OfflineBanner {...conn} />
      <RecordLayout
        head={<ReviewHead count={report.queue.length} />}
        rail={<RailSection label="Projects">{projectList}</RailSection>}
        railLabel="Project list"
        chips={[{ content: projectList, count: report.projects.length, label: 'Projects' }]}
        className={cn(conn.offline && 'offline-demoted')}
      >
        <DecideSection report={report} />
        <TriageSection triage={report.triage} />
      </RecordLayout>
      {sheet}
    </>
  );
}
