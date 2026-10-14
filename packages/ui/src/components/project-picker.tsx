import { useQuery } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';

import { usePinProject } from '../api/mutations';
import { archivedProjectsQuery, projectsQuery, reviewQuery } from '../api/queries';
import type { WireNode } from '../api/types';
import { cn } from '../lib/cn';
import { connectivity } from '../lib/connectivity';
import { filterProjects, groupProjects, projectSwitchTarget } from '../lib/project-switcher';
import { NewProjectSheet } from './new-project-sheet';
import { StatusDot } from './status-dot';
import { PopoverContent, PopoverRoot, PopoverTrigger } from './ui/popover';

/**
 * The project switcher: the sidebar's header (MMR-496, MMR-497). Its button
 * names the current project and, when other projects have decisions waiting,
 * says how many. It opens a searchable popover: pinned projects first, then
 * the rest by recent activity, each with its decision count and a pin toggle;
 * archived projects fold away at the bottom. A trailing "+ New project" row
 * opens the create-project sheet (MMR-230).
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
  const current = projects.data?.items.find((p) => p.id === projectKey);
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
          {current !== undefined && <StatusDot status={current.status} />}
          <span className="font-mono text-meta font-bold text-ink-bright">{projectKey}</span>
          <span className="min-w-0 flex-1 truncate text-body font-semibold text-ink-bright">
            {current?.title}
          </span>
          {elsewhere > 0 && (
            <span className="flex shrink-0 items-center gap-1 text-micro font-semibold text-attention-foreground before:size-1.5 before:rounded-full before:bg-attention">
              {elsewhere} elsewhere
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

const SEARCH_LABEL = 'Find a project';

/**
 * The popover's body: the search box (a combobox that owns the keyboard), the
 * listbox of pinned then recent projects, the folded archive, and the New
 * project row. Focus stays in the search box; the arrows move the active row.
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
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const projects = useQuery(projectsQuery);
  const archived = useQuery(archivedProjectsQuery);

  const groups = groupProjects(projects.data?.items ?? []);
  const pinned = filterProjects(groups.pinned, query);
  const rest = filterProjects(groups.rest, query);
  const rows = [...pinned, ...rest];
  const archivedRows = filterProjects(archived.data?.items ?? [], query);
  const active = rows[Math.min(activeIndex, rows.length - 1)];

  const move = (step: number) => {
    if (rows.length > 0) {
      setActiveIndex((i) => (Math.min(i, rows.length - 1) + step + rows.length) % rows.length);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        move(1);
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        move(-1);
        break;
      }
      case 'Enter': {
        event.preventDefault();
        if (active !== undefined) {
          onPick(active.id);
        }
        break;
      }
      default: {
        break;
      }
    }
  };

  const rowProps = (p: WireNode) => ({
    active: p.id === active?.id,
    current: p.id === projectKey,
    decisions: decisions.get(p.id) ?? 0,
    id: `${listId}-${p.id}`,
    offline,
    onActivate: () => {
      setActiveIndex(rows.findIndex((r) => r.id === p.id));
    },
    onPick: () => {
      onPick(p.id);
    },
    onPinned: () => searchRef.current?.focus(),
    project: p,
  });

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
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active === undefined ? undefined : `${listId}-${active.id}`}
            autoComplete="off"
            spellCheck={false}
            placeholder={SEARCH_LABEL}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onKeyDown}
            className="min-w-0 flex-1 bg-transparent text-meta text-ink-bright outline-none placeholder:text-ink-faint"
          />
          <kbd className="shrink-0 font-mono text-micro text-ink-ghost max-md:hidden">↑↓ ↵</kbd>
        </div>
      </div>
      <div className="min-h-0 overflow-y-auto px-1.5 pb-1.5">
        <div id={listId} role="listbox" aria-label="Projects">
          {pinned.length > 0 && (
            <Group label="Pinned">
              {pinned.map((p) => (
                <ProjectRow key={p.id} {...rowProps(p)} />
              ))}
            </Group>
          )}
          {rest.length > 0 && (
            <Group label="Recent">
              {rest.map((p) => (
                <ProjectRow key={p.id} {...rowProps(p)} />
              ))}
            </Group>
          )}
        </div>
        {rows.length === 0 && archivedRows.length === 0 && (
          <p className="px-2 py-3 text-xs text-ink-dim">No project matches “{query.trim()}”.</p>
        )}
        {archivedRows.length > 0 && (
          <div className="mt-1">
            <button
              type="button"
              aria-expanded={showArchived}
              onClick={() => {
                setShowArchived((v) => !v);
              }}
              className="microlabel flex w-full items-center gap-1.5 rounded-sm px-2 py-2 text-left text-ink-faint hover:text-ink-dim focus-visible:outline-2 focus-visible:outline-accent"
            >
              <span aria-hidden="true">{showArchived ? '▾' : '▸'}</span>
              Archived · {archivedRows.length}
            </button>
            {showArchived && (
              <ul className="flex flex-col gap-px">
                {archivedRows.map((p) => (
                  <li
                    key={p.id}
                    className="flex min-w-0 items-center gap-2 px-2 py-1.5 text-meta text-ink-ghost"
                  >
                    <span className="w-10 shrink-0 font-mono text-mono-id font-bold">{p.id}</span>
                    <span className="min-w-0 flex-1 truncate">{p.title}</span>
                  </li>
                ))}
              </ul>
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
 * One project in the listbox. Clicking it, or Enter while it is active, picks
 * it. The pin toggle is a control inside the row that never picks.
 */
function ProjectRow({
  project,
  id,
  active,
  current,
  decisions,
  offline,
  onActivate,
  onPick,
  onPinned,
}: {
  project: WireNode;
  id: string;
  active: boolean;
  current: boolean;
  decisions: number;
  offline: boolean;
  onActivate: () => void;
  onPick: () => void;
  onPinned: () => void;
}) {
  const pin = usePinProject(project.id);
  const pinned = project.pinned === true;
  return (
    // The search box owns the keyboard (aria-activedescendant), so the row only
    // needs the pointer: click picks, moving over it makes it the active row.
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events
    <div
      id={id}
      role="option"
      tabIndex={-1}
      aria-selected={active}
      aria-current={current ? 'true' : undefined}
      data-project={project.id}
      data-active={active ? '' : undefined}
      onClick={onPick}
      onPointerMove={onActivate}
      className={cn(
        'group/row flex min-w-0 cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-meta text-ink-dim max-md:py-2.5',
        'data-[active]:bg-well-800',
        'aria-[current]:bg-accent/10 aria-[current]:text-ink-bright aria-[current]:inset-ring aria-[current]:inset-ring-accent/28',
      )}
    >
      <StatusDot status={project.status} />
      <span className="w-10 shrink-0 font-mono text-meta font-bold text-ink-bright">
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
      <button
        type="button"
        aria-pressed={pinned}
        aria-label={`${pinned ? 'Unpin' : 'Pin'} ${project.id}`}
        disabled={offline}
        onClick={(event) => {
          event.stopPropagation();
          pin.mutate(!pinned);
          onPinned();
        }}
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded text-ink-faint transition-colors hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent max-md:size-9',
          'md:opacity-0 md:group-data-[active]/row:opacity-100 md:group-hover/row:opacity-100 md:focus-visible:opacity-100',
          'aria-pressed:text-accent aria-pressed:opacity-100',
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
          aria-hidden="true"
        >
          <path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
        </svg>
      </button>
    </div>
  );
}
