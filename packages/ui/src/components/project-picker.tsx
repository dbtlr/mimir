import { useQuery } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';

import { usePendingPins, usePinProject } from '../api/mutations';
import { archivedProjectsQuery, projectsQuery, reviewQuery } from '../api/queries';
import type { WireNode } from '../api/types';
import { cn } from '../lib/cn';
import { connectivity } from '../lib/connectivity';
import {
  filterProjects,
  groupProjects,
  overlayPins,
  projectSwitchTarget,
} from '../lib/project-switcher';
import { NewProjectSheet } from './new-project-sheet';
import { StatusDot } from './status-dot';
import { PopoverContent, PopoverRoot, PopoverTrigger } from './ui/popover';

/**
 * The project switcher: the sidebar's header (MMR-496, MMR-497). Its button
 * names the current project and, when other projects have decisions waiting,
 * says how many. It opens a searchable popover: pinned projects first, then
 * the rest by recent activity, each with its decision count; archived projects
 * fold away at the bottom. A trailing "+ New project" row opens the
 * create-project sheet (MMR-230).
 *
 * The same popover opens inside the phone drawer; `onNavigate` lets the drawer
 * close behind a pick.
 */
export function ProjectPicker({
  projectKey,
  onNavigate,
}: {
  projectKey: string;
  /** Called when a pick moves the page, so a drawer can close behind it. */
  onNavigate?: () => void;
}) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const projects = useQuery(projectsQuery);
  const review = useQuery(reviewQuery);
  const conn = connectivity([projects]);
  const active = projects.data?.items.find((p) => p.id === projectKey);
  // An archived project's pages still open (as the unavailable notice), so the
  // header names it from the archived list once the active list lacks it.
  const archived = useQuery({
    ...archivedProjectsQuery,
    enabled: projects.isSuccess && active === undefined,
  });
  const frozen =
    active === undefined ? archived.data?.items.find((p) => p.id === projectKey) : undefined;
  const current = active ?? frozen;
  const decisionsByKey = new Map(review.data?.projects.map((p) => [p.key, p.decisions]));
  const elsewhere = [...decisionsByKey]
    .filter(([key]) => key !== projectKey)
    .reduce((sum, [, count]) => sum + count, 0);

  const pick = (key: string) => {
    setOpen(false);
    if (key === projectKey) {
      return;
    }
    onNavigate?.();
    void navigate(projectSwitchTarget(pathname, key));
  };

  return (
    <>
      <PopoverRoot open={open} onOpenChange={setOpen}>
        <PopoverTrigger className="group flex w-full items-center gap-2 rounded-lg bg-well-850 px-2.5 py-2 text-left inset-ring inset-ring-line-bright transition-colors hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent data-[popup-open]:inset-ring-accent/45">
          {active !== undefined && <StatusDot status={active.status} />}
          {frozen !== undefined && <Snowflake />}
          <span
            className={cn(
              'font-mono text-meta font-bold text-ink-bright',
              frozen !== undefined && 'text-ink-faint',
            )}
          >
            {projectKey}
          </span>
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-body font-semibold text-ink-bright',
              frozen !== undefined && 'text-ink-faint',
            )}
          >
            {current?.title}
          </span>
          {elsewhere > 0 && (
            <span className="flex shrink-0 items-center gap-1 text-micro font-semibold text-attention-foreground before:size-1.5 before:rounded-full before:bg-attention">
              <span aria-hidden="true">{elsewhere} elsewhere</span>
              <span className="sr-only">
                {elsewhere} {elsewhere === 1 ? 'decision' : 'decisions'} in other projects
              </span>
            </span>
          )}
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            className="shrink-0 text-ink-faint transition-transform group-data-[popup-open]:rotate-180"
          >
            <path
              d="m6 9 6 6 6-6"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          initialFocus={searchRef}
          className="w-[min(360px,calc(100vw-2rem))] bg-well-850"
        >
          {open && (
            <SwitcherPanel
              projectKey={projectKey}
              decisions={decisionsByKey}
              searchRef={searchRef}
              offline={conn.offline}
              onPick={pick}
              onNew={() => {
                setOpen(false);
                setCreating(true);
              }}
            />
          )}
        </PopoverContent>
      </PopoverRoot>
      <NewProjectSheet open={creating} onOpenChange={setCreating} />
    </>
  );
}

/** The mark of a frozen project, as on the archived shelf. */
function Snowflake() {
  return (
    <span aria-hidden="true" className="shrink-0 text-tag text-ink-ghost">
      ❄
    </span>
  );
}

const SEARCH_LABEL = 'Find a project';

/** What the list says in place of rows, or undefined when it has rows or nothing to say. */
function emptyMessage(input: {
  query: string;
  hasRows: boolean;
  failed: boolean;
  loading: boolean;
}): string | undefined {
  const { query, hasRows, failed, loading } = input;
  if (hasRows) {
    return undefined;
  }
  const typed = query.trim();
  if (typed !== '') {
    return `No project matches “${typed}”.`;
  }
  if (failed) {
    return 'Couldn’t load the projects.';
  }
  return loading ? 'Loading projects…' : undefined;
}

/**
 * The popover's body: the search box (a combobox that owns the keyboard), the
 * listbox of pinned then recent projects, the folded archive, and the New
 * project row. Focus stays in the search box; the arrows move the highlighted
 * row, Enter opens it, and Alt+P pins it. A row holds no control of its own.
 */
function SwitcherPanel({
  projectKey,
  decisions,
  searchRef,
  offline,
  onPick,
  onNew,
}: {
  projectKey: string;
  decisions: ReadonlyMap<string, number>;
  searchRef: RefObject<HTMLInputElement | null>;
  offline: boolean;
  onPick: (key: string) => void;
  onNew: () => void;
}) {
  const listId = useId();
  const archivedId = useId();
  const [query, setQuery] = useState('');
  // The highlight follows its project while the list reorders or refreshes,
  // and falls back to the first row when that project is filtered out.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const projects = useQuery(projectsQuery);
  const archived = useQuery(archivedProjectsQuery);
  const pin = usePinProject();
  const pendingPins = usePendingPins();

  // A pin in flight shows as already made; the server's list catches up on settle.
  const groups = groupProjects(overlayPins(projects.data?.items ?? [], pendingPins));
  const pinned = filterProjects(groups.pinned, query);
  const rest = filterProjects(groups.rest, query);
  const archivedRows = filterProjects(archived.data?.items ?? [], query);
  const rows = [...pinned, ...rest, ...(showArchived ? archivedRows : [])];
  const activeIndex = Math.max(
    0,
    rows.findIndex((r) => r.id === activeKey),
  );
  const active = rows.at(activeIndex);
  const optionId = (key: string) => `${listId}-${key}`;
  const activeOptionId = active === undefined ? undefined : optionId(active.id);
  const message = emptyMessage({
    failed: projects.isError,
    hasRows: pinned.length + rest.length > 0 || archivedRows.length > 0,
    loading: projects.isPending,
    query,
  });

  // The input keeps focus, so the list scrolls the highlighted row into view.
  useEffect(() => {
    if (activeOptionId !== undefined) {
      document.getElementById(activeOptionId)?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeOptionId]);

  const togglePin = (project: WireNode) => {
    // Archived projects cannot be written, and nothing saves offline.
    if (offline || project.archived_at != null) {
      return;
    }
    const next = project.pinned !== true;
    pin.mutate({ key: project.id, pinned: next });
    setActiveKey(project.id);
    setAnnouncement(`${next ? 'Pinned' : 'Unpinned'} ${project.id}`);
    searchRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.altKey && event.code === 'KeyP') {
      event.preventDefault();
      if (active !== undefined) {
        togglePin(active);
      }
      return;
    }
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (step !== undefined) {
      event.preventDefault();
      setActiveKey(rows.at((activeIndex + step) % rows.length)?.id ?? null);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (active !== undefined) {
        onPick(active.id);
      }
    }
  };

  const row = (p: WireNode) => (
    <ProjectOption
      key={p.id}
      project={p}
      id={optionId(p.id)}
      active={p.id === active?.id}
      current={p.id === projectKey}
      decisions={decisions.get(p.id) ?? 0}
      pinnable={!offline}
      onActivate={() => {
        setActiveKey(p.id);
      }}
      onPick={() => {
        onPick(p.id);
      }}
      onTogglePin={() => {
        togglePin(p);
      }}
    />
  );

  return (
    <>
      <div className="p-2.5">
        <div className="flex items-center gap-2 rounded-lg bg-well-950 px-2.5 py-1.5 inset-ring inset-ring-accent focus-within:inset-ring-2">
          <span aria-hidden="true" className="text-ink-faint">
            ⌕
          </span>
          <input
            ref={searchRef}
            role="combobox"
            aria-label={SEARCH_LABEL}
            aria-expanded="true"
            aria-controls={showArchived ? `${listId} ${archivedId}` : listId}
            aria-autocomplete="list"
            aria-activedescendant={activeOptionId}
            aria-keyshortcuts="Alt+P"
            autoComplete="off"
            spellCheck={false}
            placeholder={SEARCH_LABEL}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveKey(null);
            }}
            onKeyDown={onKeyDown}
            className="min-w-0 flex-1 bg-transparent text-meta text-ink-bright outline-none placeholder:text-ink-faint"
          />
          <kbd className="shrink-0 font-mono text-micro text-ink-ghost max-md:hidden">↑↓ ↵ ⌥P</kbd>
        </div>
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <div className="min-h-0 overflow-y-auto px-1.5 pb-1.5">
        <div id={listId} role="listbox" aria-label="Projects">
          {pinned.length > 0 && <Group label="Pinned">{pinned.map(row)}</Group>}
          {rest.length > 0 && <Group label="Recent">{rest.map(row)}</Group>}
        </div>
        {message !== undefined && <p className="px-2 py-3 text-xs text-ink-dim">{message}</p>}
        {archivedRows.length > 0 && (
          <div className="mt-1">
            <button
              type="button"
              aria-expanded={showArchived}
              // Keep focus in the search box, so the keys still drive the list.
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                setShowArchived((v) => !v);
              }}
              className="microlabel flex w-full items-center gap-1.5 rounded-sm px-2 py-2 text-left text-ink-faint hover:text-ink-dim focus-visible:outline-2 focus-visible:outline-accent"
            >
              <span aria-hidden="true">{showArchived ? '▾' : '▸'}</span>
              Archived · {archivedRows.length}
            </button>
            {showArchived && (
              <div id={archivedId} role="listbox" aria-label="Archived projects">
                {archivedRows.map(row)}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="border-t border-line p-1.5">
        <button
          type="button"
          disabled={offline}
          onClick={onNew}
          className="w-full rounded-md px-2 py-2 text-left text-meta font-medium text-ink-dim transition-colors hover:bg-well-800 hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40 max-md:py-3"
        >
          + New project
        </button>
      </div>
    </>
  );
}

/** A labelled run of rows inside the listbox. */
function Group({ label, children }: { label: string; children: ReactNode }) {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId}>
      <span id={labelId} className="microlabel block px-2 pt-2.5 pb-1 text-ink-faint">
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * One project in a listbox. It takes only the pointer: a click opens it, and
 * the pin icon, a pointer-only affordance, toggles the pin. The keyboard does
 * both from the search box (Enter, Alt+P). An archived project opens but
 * carries no pin.
 */
function ProjectOption({
  project,
  id,
  active,
  current,
  decisions,
  pinnable,
  onActivate,
  onPick,
  onTogglePin,
}: {
  project: WireNode;
  id: string;
  active: boolean;
  current: boolean;
  decisions: number;
  pinnable: boolean;
  onActivate: () => void;
  onPick: () => void;
  onTogglePin: () => void;
}) {
  const frozen = project.archived_at != null;
  const pinned = project.pinned === true;
  return (
    // The search box owns focus and the keys (aria-activedescendant); a row
    // takes only the pointer.
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events
    <div
      id={id}
      role="option"
      tabIndex={-1}
      aria-selected={active}
      aria-current={current ? 'true' : undefined}
      data-project={project.id}
      // Keep focus in the search box, so the keys still drive the list after a click.
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={onPick}
      onPointerMove={onActivate}
      className={cn(
        'group/row flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-meta text-ink-dim max-md:py-2.5',
        'aria-selected:bg-well-800',
        'aria-[current]:bg-accent/10 aria-[current]:text-ink-bright aria-[current]:inset-ring aria-[current]:inset-ring-accent/28',
        frozen && 'text-ink-ghost',
      )}
    >
      {frozen ? <Snowflake /> : <StatusDot status={project.status} />}
      <span
        className={cn(
          'w-10 shrink-0 font-mono text-meta font-bold',
          frozen ? 'text-ink-ghost' : 'text-ink-bright',
        )}
      >
        {project.id}
      </span>
      <span className="min-w-0 flex-1 truncate">{project.title}</span>
      {decisions > 0 && (
        <span
          aria-label={`${String(decisions)} ${decisions === 1 ? 'decision' : 'decisions'}`}
          className="shrink-0 rounded-full bg-attention/12 px-[7px] text-tag font-semibold text-attention-foreground inset-ring inset-ring-attention/24"
        >
          {decisions}
        </span>
      )}
      {pinned && <span className="sr-only">, pinned</span>}
      {!frozen && (
        // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
        <span
          aria-hidden="true"
          data-pin=""
          onClick={(event) => {
            event.stopPropagation();
            onTogglePin();
          }}
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded text-ink-faint transition-colors hover:text-ink-bright max-md:size-9',
            !pinned &&
              'md:opacity-0 md:group-aria-selected/row:opacity-100 md:group-hover/row:opacity-100',
            pinned && 'text-accent',
            !pinnable && 'opacity-40',
          )}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill={pinned ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
          </svg>
        </span>
      )}
    </div>
  );
}
