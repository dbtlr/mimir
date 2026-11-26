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
 * A container's row: its status dot, a project's key, the title, and the
 * tally, each left out where the row has none. The current row's title is
 * semibold, and a row that holds the page says so in words.
 */
export function ContainerRowLink({
  target,
  mark,
  status,
  projectKey,
  title,
  tally,
  indent = false,
  onNavigate,
}: {
  target: RowTarget;
  mark: RowMark;
  status?: StatusWord | undefined;
  projectKey?: string | undefined;
  title?: string | undefined;
  tally?: string | undefined;
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
        <span className="shrink-0 font-mono text-meta font-bold text-ink-bright">
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
      {tally !== undefined && (
        <>
          {' '}
          <span className="ml-auto shrink-0 font-mono text-mono-id text-ink-dim">{tally}</span>
        </>
      )}
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
 * place: "3 finished initiatives", "1 finished phase". It closes again on each
 * navigation.
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
 * The container list on a project's pages. The tree is the whole board, so it
 * is read once rather than polled, as on the record pages; a console write
 * invalidates it. An archived project's tree 404s (ADR 0015), so it is not
 * asked for once the archived list names the key: the list shows ← Home and
 * the project's row alone, and the project page says why.
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
  const archived = useArchivedProject(projectKey);
  const tree = useQuery({
    ...treeQuery(projectKey),
    enabled: archived === undefined,
    refetchInterval: false,
  });
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
  // A node id in the project segment (`/p/MMR-5`) reads back a tree that is no project's.
  const notProject = tree.data !== undefined && tree.data.type !== 'project';
  if (tree.data !== undefined && !notProject) {
    return <ContainerLevel list={containerListOf(tree.data, place)} onNavigate={onNavigate} />;
  }
  if (notProject || isNotFound(tree.error)) {
    return (
      <>
        {home}
        {bare(undefined)}
      </>
    );
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
