import type { StatusWord } from '@mimir/contract';
import { useQuery } from '@tanstack/react-query';
import { useLinkProps, useRouterState } from '@tanstack/react-router';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { isNotFound } from '../api/errors';
import { projectsQuery, treeQuery } from '../api/shell-queries';
import { cn } from '../lib/cn';
import { containerListOf } from '../lib/container-list';
import type { ContainerList, ContainerParent, ContainerRow } from '../lib/container-list';
import { projectPlaceOf } from '../lib/project-sidebar';
import { nodeLink } from '../lib/record-url';
import { STATUS_META } from '../lib/status';
import { useArchivedProject } from '../lib/use-archived-project';
import type { ContainerTally } from '../lib/work-page';
import { ROW_CURRENT, ROW_HOLDS, SIDEBAR_ROW } from './sidebar-selection';
import { StatusDot } from './status-dot';
import { ChevronRightIcon } from './ui/icons';
import { Skeleton } from './ui/skeleton';

/*
 * The sidebar's container list (ADR 0013, MMR-730 refinement): a link to the
 * parent, the current container, then its child containers, with the finished
 * children in one fold. Home's level (`sidebar-projects.tsx`) draws its rows
 * from the same parts.
 */

/** Where a sidebar row leads: Home, a project's page, or a node's page. */
type RowTarget =
  | { to: '/' }
  | { to: '/p/$key'; params: { key: string } }
  | { to: '/p/$key/$seq'; params: { key: string; seq: string } };

/** How a row stands to the page: it is the page, it holds the page, or neither. */
type RowMark = 'page' | 'holds' | undefined;

/** A child row, and the fold and its rows, sit 16 in from the current row. */
export const CHILD_INDENT = 'ml-4';

/** A row's tally: 12.5 mono `ink-dim` at its right edge. */
const TALLY = 'ml-auto shrink-0 font-mono text-mono-id text-ink-dim';

/** What a row shows at its right edge. */
function tallyText(tally: ContainerTally): string {
  switch (tally.kind) {
    case 'counts': {
      return `${String(tally.done)}/${String(tally.total)}`;
    }
    case 'open_ended': {
      return '∞';
    }
    case 'parked': {
      return 'parked';
    }
    case 'empty': {
      return 'Empty';
    }
    default: {
      const _exhaustive: never = tally;
      return _exhaustive;
    }
  }
}

/**
 * A row's link. The path decides its mark, not the router: a container's row
 * is the page on its own path whatever `?tab=`, and holds the page on one it
 * holds, so the router's own `aria-current` is replaced.
 */
function RowLink({
  target,
  mark,
  className,
  onNavigate,
  children,
}: {
  target: RowTarget;
  mark: RowMark;
  className?: string;
  onNavigate?: (() => void) | undefined;
  children: ReactNode;
}) {
  const linkProps = useLinkProps({ ...target, onClick: onNavigate });
  return (
    <a
      {...linkProps}
      aria-current={mark === 'page' ? 'page' : undefined}
      data-holds={mark === 'holds' ? 'true' : undefined}
      className={cn(SIDEBAR_ROW, ROW_CURRENT, ROW_HOLDS, className)}
    >
      {children}
    </a>
  );
}

/**
 * A container's row: its status dot, a project's key in the switcher row's
 * key column, the title, and the tally, each left out where the row has none.
 * The current row's title is semibold. A screen reader hears the dot's status
 * in words, and that a row holds the page. `tallyName` is what a screen reader hears in place of a bare
 * tally ("4 projects"). `trailing` takes the tally's place with a part of its
 * own, as Home's projects do with their needs-you count.
 */
export function ContainerRowLink({
  target,
  mark,
  status,
  projectKey,
  title,
  tally,
  tallyName,
  trailing,
  indent = false,
  onNavigate,
}: {
  target: RowTarget;
  mark: RowMark;
  status?: StatusWord | undefined;
  projectKey?: string | undefined;
  title?: string | undefined;
  tally?: string | undefined;
  tallyName?: string | undefined;
  trailing?: ReactNode;
  indent?: boolean;
  onNavigate?: (() => void) | undefined;
}) {
  return (
    <RowLink
      target={target}
      mark={mark}
      onNavigate={onNavigate}
      className={indent ? CHILD_INDENT : undefined}
    >
      {status !== undefined && <StatusDot status={status} />}
      {projectKey !== undefined && (
        <span className="w-10 shrink-0 font-mono text-meta font-bold text-ink-bright">
          {projectKey}
        </span>
      )}
      {/* The spaces part the row's accessible name; flex layout drops them visually. */}
      {title !== undefined && (
        <>
          {' '}
          <span className={cn('min-w-0 flex-1 truncate', mark !== undefined && 'font-semibold')}>
            {title}
          </span>
        </>
      )}
      {tally !== undefined && tallyName === undefined && (
        <>
          {' '}
          <span className={TALLY}>{tally}</span>
        </>
      )}
      {tally !== undefined && tallyName !== undefined && (
        <>
          <span aria-hidden="true" className={TALLY}>
            {' '}
            {tally}
          </span>
          <span className="sr-only">, {tallyName}</span>
        </>
      )}
      {trailing !== undefined && <> {trailing}</>}
      {/* The dot is aria-hidden, so its status is said in words too (MMR-807). */}
      {status !== undefined && <span className="sr-only">, {STATUS_META[status].label}</span>}
      {mark === 'holds' && <span className="sr-only">, contains this page</span>}
    </RowLink>
  );
}

/** The link up a level: "←" and the parent's title, in `ink-dim`, with no dot or tally. */
function ParentLink({
  target,
  title,
  onNavigate,
}: {
  target: RowTarget;
  title: string;
  onNavigate?: (() => void) | undefined;
}) {
  return (
    <RowLink target={target} mark={undefined} onNavigate={onNavigate} className="text-ink-dim">
      <span className="w-2 shrink-0 text-center font-semibold">←</span>{' '}
      <span className="min-w-0 flex-1 truncate">{title}</span>
    </RowLink>
  );
}

/** Where a container's row leads: a project's page or a node's. */
function targetOf(row: Pick<ContainerRow, 'id' | 'type'>): RowTarget {
  return row.type === 'project' ? { params: { key: row.id }, to: '/p/$key' } : nodeLink(row.id);
}

function parentTarget(parent: ContainerParent): RowTarget {
  return parent.kind === 'home' ? { to: '/' } : targetOf(parent);
}

/**
 * Whether a fold is open: shut at first, and shut again whenever `resetKey`
 * changes, with the reader's own toggles in between. The sidebar outlives page
 * changes, so the fold keys this on the path without remounting.
 */
function useFoldState(resetKey: string) {
  const [open, setOpen] = useState(false);
  const [seenKey, setSeenKey] = useState(resetKey);
  if (seenKey !== resetKey) {
    setSeenKey(resetKey);
    setOpen(false);
  }
  return [open, setOpen] as const;
}

/**
 * The finished children, in one fold at the end of the list that opens in
 * place: "3 finished initiatives", "1 finished phase". It closes again when
 * you move to another page; a change of `?tab=` alone leaves it open.
 */
function FinishedFold({
  rows,
  onNavigate,
}: {
  rows: ContainerRow[];
  onNavigate?: (() => void) | undefined;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [open, setOpen] = useFoldState(pathname);
  const noun = rows[0]?.type === 'phase' ? 'phase' : 'initiative';
  return (
    <details
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
      className={CHILD_INDENT}
    >
      <summary
        className={cn(
          SIDEBAR_ROW,
          'cursor-pointer list-none text-ink-dim [&::-webkit-details-marker]:hidden',
        )}
      >
        <ChevronRightIcon
          className={cn(
            'size-3 shrink-0 transition-transform [stroke-width:2.5] md:size-3',
            open && 'rotate-90',
          )}
        />
        {rows.length} finished {rows.length === 1 ? noun : `${noun}s`}
      </summary>
      <div className="flex flex-col gap-px">
        {rows.map((row) => (
          <ContainerRowLink
            key={row.id}
            target={targetOf(row)}
            mark={undefined}
            status={row.status}
            title={row.title}
            tally={tallyText(row.tally)}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </details>
  );
}

/** A project's level, an initiative's, or a phase's, built from the tree. */
function ContainerLevel({
  list,
  onNavigate,
}: {
  list: ContainerList;
  onNavigate?: (() => void) | undefined;
}) {
  const { parent, current, mark, children, finished } = list;
  return (
    <>
      <ParentLink
        target={parentTarget(parent)}
        title={parent.kind === 'home' ? 'Home' : parent.title}
        onNavigate={onNavigate}
      />
      <ContainerRowLink
        target={targetOf(current)}
        mark={mark}
        status={current.status}
        projectKey={current.type === 'project' ? current.id : undefined}
        title={current.title}
        tally={tallyText(current.tally)}
        onNavigate={onNavigate}
      />
      {children.map((row) => (
        <ContainerRowLink
          key={row.id}
          target={targetOf(row)}
          mark={undefined}
          status={row.status}
          title={row.title}
          tally={tallyText(row.tally)}
          indent
          onNavigate={onNavigate}
        />
      ))}
      {finished.length > 0 && <FinishedFold rows={finished} onNavigate={onNavigate} />}
    </>
  );
}

/**
 * A project's structure as the sidebar reads it: the archived project the key
 * names, the project's tree, and whether that tree reads as missing or as no
 * project's. The tree is the whole board, so it is read once rather than
 * polled, as on the record pages; a console write invalidates it. An archived
 * project's tree 404s (ADR 0015), so it is not asked for once the archived
 * list names the key. The container list and the Needs you slot share it.
 */
export function useProjectStructure(projectKey: string) {
  const archived = useArchivedProject(projectKey);
  const tree = useQuery({
    ...treeQuery(projectKey),
    enabled: archived === undefined,
    refetchInterval: false,
  });
  // A node id in the project segment (`/p/MMR-5`) reads back a tree that is no project's.
  const notProject = tree.data !== undefined && tree.data.type !== 'project';
  // A refetch that 404s (archived in another tab) outranks the tree still cached.
  const unavailable = notProject || isNotFound(tree.error);
  return { archived, tree, unavailable };
}

/**
 * The container list on a project's pages, from `useProjectStructure`. An
 * archived project shows ← Home and the project's row alone, and the project
 * page says why.
 */
export function ProjectContainers({
  projectKey,
  onNavigate,
}: {
  projectKey: string;
  onNavigate?: (() => void) | undefined;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const place = projectPlaceOf(pathname) ?? { kind: 'project' };
  const { archived, tree, unavailable } = useProjectStructure(projectKey);
  const projects = useQuery(projectsQuery);
  const home = <ParentLink target={{ to: '/' }} title="Home" onNavigate={onNavigate} />;
  const bare = (title: string | undefined) => (
    <ContainerRowLink
      target={{ params: { key: projectKey }, to: '/p/$key' }}
      mark={place.kind === 'project' ? 'page' : 'holds'}
      projectKey={projectKey}
      title={title}
      onNavigate={onNavigate}
    />
  );
  if (archived !== undefined) {
    return (
      <>
        {home}
        {bare(archived.title)}
      </>
    );
  }
  if (unavailable) {
    return (
      <>
        {home}
        {bare(undefined)}
      </>
    );
  }
  if (tree.data !== undefined) {
    return <ContainerLevel list={containerListOf(tree.data, place)} onNavigate={onNavigate} />;
  }
  if (tree.isError) {
    return (
      <>
        {home}
        {bare(projects.data?.find((p) => p.id === projectKey)?.title)}
        <p className="px-2 py-1.5 text-xs text-ink-dim">Couldn’t load the structure.</p>
      </>
    );
  }
  return (
    <>
      {home}
      <Skeleton aria-busy="true" className="mx-2 my-1 h-16" />
    </>
  );
}
