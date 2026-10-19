import type { EngineNode } from '@mimir/contract';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { usePendingPins } from '../api/shell-mutations';
import { archivedProjectsQuery, projectsQuery } from '../api/shell-queries';
import { reviewQuery } from '../api/view-queries';
import { cn } from '../lib/cn';
import { connectivity } from '../lib/connectivity';
import {
  filterProjects,
  groupProjects,
  overlayPins,
  projectSwitchTarget,
  sidebarShortlist,
} from '../lib/project-switcher';
import { useHotkey } from '../lib/use-hotkey';
import {
  PROJECT_ROW,
  ProjectOption,
  ProjectRowContent,
  projectListMessage,
  usePinToggle,
  useProjectListbox,
} from './project-options';

/*
 * The All projects sidebar's Projects section (MMR-562, ADR 0013 refinement):
 * a search box over the pinned projects, so each is one click from `/`. At
 * rest the rows are links: the pinned projects or, with none pinned, the most
 * recently active few, then a count of what a search would find. Focusing the
 * search turns the rows into the switcher's listbox and keys: typing filters
 * every project, archived ones last, Enter opens the highlighted one, and
 * Alt+P pins it. `/` focuses the search; leaving it clears the search, so no
 * listbox outlives the focus and the page's bare hotkeys keep working.
 */

const SEARCH_LABEL = 'Search projects';

/** The line under the resting rows: how many more projects a search would find. */
function moreLine(more: number): string {
  return more === 1
    ? '1 more project. Search to find it.'
    : `${String(more)} more projects. Search to find them.`;
}

/** A resting row: a link to the project's work page. */
function ProjectLink({
  project,
  decisions,
  onNavigate,
}: {
  project: EngineNode;
  decisions: number;
  onNavigate?: () => void;
}) {
  return (
    <li>
      <Link
        to="/p/$key"
        params={{ key: project.id }}
        onClick={onNavigate}
        data-project={project.id}
        className={cn(
          PROJECT_ROW,
          'transition-colors hover:bg-well-800 hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent',
        )}
      >
        <ProjectRowContent project={project} decisions={decisions} />
      </Link>
    </li>
  );
}

/** The Projects section. `onNavigate` fires when a pick moves the page, so the drawer can close. */
export function SidebarProjects({ onNavigate }: { onNavigate?: () => void }) {
  const headingId = useId();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const typed = query.trim() !== '';
  const projects = useQuery(projectsQuery);
  // The archive matters only to a typed search; the resting rows never show it.
  const archived = useQuery({ ...archivedProjectsQuery, enabled: typed });
  const review = useQuery(reviewQuery());
  const pendingPins = usePendingPins();
  const { offline } = connectivity([projects]);
  const { announcement, toggle } = usePinToggle(offline);
  const decisions = new Map(review.data?.projects.map((p) => [p.key, p.decisions]));

  // A pin in flight shows as already made; the server's list catches up on settle.
  const groups = groupProjects(overlayPins(projects.data ?? [], pendingPins));
  const shortlist = sidebarShortlist(groups);
  const rows = typed
    ? [
        ...filterProjects(groups.pinned, query),
        ...filterProjects(groups.rest, query),
        ...filterProjects(archived.data ?? [], query),
      ]
    : shortlist.shown;

  const pick = (key: string) => {
    onNavigate?.();
    void navigate(projectSwitchTarget(pathname, key));
  };
  const listbox = useProjectListbox({
    keys: rows.map((r) => r.id),
    onPick: pick,
    onTogglePin: (key) => {
      const project = rows.find((r) => r.id === key);
      return project !== undefined && toggle(project);
    },
    // No project is where the operator is, so the highlight starts on the first row.
    restingKey: '',
  });
  const message = projectListMessage({
    failed: projects.isError,
    hasRows: rows.length > 0,
    loading: projects.isPending,
    query,
  });

  useHotkey('/', () => {
    searchRef.current?.focus();
  });

  const clearSearch = () => {
    setQuery('');
    listbox.setActiveKey(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
      if (query === '') {
        // Nothing left to clear: Escape leaves the search, and in the phone
        // drawer goes on to close it.
        searchRef.current?.blur();
        return;
      }
      // Clearing is all this Escape does; the drawer around it stays open.
      event.stopPropagation();
      clearSearch();
      return;
    }
    listbox.onKeyDown(event);
  };

  return (
    <section aria-labelledby={headingId} className="mt-3 flex flex-col gap-0.5">
      <h2 id={headingId} className="microlabel px-2 pb-1 text-ink-faint">
        Projects
      </h2>
      <div className="mb-1 flex items-center gap-2 rounded-lg bg-well-900 px-2.5 py-1.5 inset-ring inset-ring-line-bright focus-within:inset-ring-2 focus-within:inset-ring-accent">
        <span aria-hidden="true" className="text-ink-faint">
          ⌕
        </span>
        <input
          ref={searchRef}
          role="combobox"
          aria-label={SEARCH_LABEL}
          aria-expanded={searching}
          aria-controls={searching ? listbox.listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={searching ? listbox.activeOptionId : undefined}
          aria-keyshortcuts="/ Alt+P"
          autoComplete="off"
          spellCheck={false}
          placeholder={SEARCH_LABEL}
          value={query}
          onFocus={() => {
            setSearching(true);
          }}
          onBlur={() => {
            setSearching(false);
            clearSearch();
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            listbox.setActiveKey(null);
          }}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent text-meta text-ink-bright outline-none placeholder:text-ink-faint"
        />
        <kbd className="shrink-0 font-mono text-micro text-ink-ghost max-lg:hidden">
          {searching ? 'esc' : '/'}
        </kbd>
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {searching ? (
        <div id={listbox.listId} role="listbox" aria-label="Matching projects">
          {rows.map((p) => (
            <ProjectOption
              key={p.id}
              project={p}
              id={listbox.optionId(p.id)}
              active={p.id === listbox.activeOption}
              current={false}
              decisions={decisions.get(p.id) ?? 0}
              pinnable={!offline}
              onActivate={() => {
                listbox.setActiveKey(p.id);
              }}
              onPick={() => {
                pick(p.id);
              }}
              onTogglePin={() => {
                if (toggle(p)) {
                  listbox.setActiveKey(p.id);
                }
              }}
            />
          ))}
        </div>
      ) : (
        <ul aria-label={groups.pinned.length > 0 ? 'Pinned projects' : 'Recent projects'}>
          {rows.map((p) => (
            <ProjectLink
              key={p.id}
              project={p}
              decisions={decisions.get(p.id) ?? 0}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      )}
      {message !== undefined && <p className="px-2 py-1.5 text-xs text-ink-dim">{message}</p>}
      {!typed && shortlist.more > 0 && (
        <p className="px-2 py-1.5 text-xs text-ink-faint">{moreLine(shortlist.more)}</p>
      )}
    </section>
  );
}
