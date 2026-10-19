import type { EngineNode } from '@mimir/contract';
import { useEffect, useId, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { usePinProject } from '../api/shell-mutations';
import { cn } from '../lib/cn';
import { ALL_PROJECTS_KEY } from '../lib/project-switcher';
import { StatusDot } from './status-dot';

/*
 * The project rows the switcher's popover (MMR-497) and the All projects
 * sidebar's Projects section (MMR-562) share, and the switcher's listbox: a
 * search box that owns focus as a combobox over its rows, with its keys and
 * its pin.
 */

/** The violet count of decisions waiting; nothing at zero. */
export function DecisionCount({ count }: { count: number }) {
  if (count <= 0) {
    return null;
  }
  return (
    <span
      aria-label={`${String(count)} ${count === 1 ? 'decision' : 'decisions'}`}
      className="shrink-0 rounded-full bg-attention/12 px-[7px] text-tag font-semibold text-attention-foreground inset-ring inset-ring-attention/24"
    >
      {count}
    </span>
  );
}

/** The mark of a frozen project, as on an archived project’s page. */
export function Snowflake() {
  return (
    <span aria-hidden="true" className="shrink-0 text-tag text-ink-ghost">
      ❄
    </span>
  );
}

/** What a project list says in place of rows, or undefined when it has rows or nothing to say. */
export function projectListMessage(input: {
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

/** A project row's geometry, shared by the listbox option and the sidebar's link. */
export const PROJECT_ROW =
  'flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-meta text-ink-dim max-md:py-2.5';

/** A project row's content: its status (or snowflake), key, title, and decision count. */
export function ProjectRowContent({
  project,
  decisions,
}: {
  project: EngineNode;
  decisions: number;
}) {
  const frozen = project.archivedAt != null;
  return (
    <>
      {frozen ? <Snowflake /> : <StatusDot status={project.status} />}
      <span
        className={cn(
          'w-10 shrink-0 font-mono text-meta font-bold',
          frozen ? 'text-ink-ghost' : 'text-ink-bright',
        )}
      >
        {project.id}
      </span>{' '}
      {/* The spaces part the row's accessible name; flex layout drops them visually. */}
      <span className="min-w-0 flex-1 truncate">{project.title}</span>{' '}
      <DecisionCount count={decisions} />
    </>
  );
}

/**
 * One project in a listbox. It takes only the pointer: a click opens it, and
 * the pin icon, a pointer-only affordance, toggles the pin. The keyboard does
 * both from the search box (Enter, Alt+P). An archived project opens but
 * carries no pin.
 */
export function ProjectOption({
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
  project: EngineNode;
  id: string;
  active: boolean;
  current: boolean;
  decisions: number;
  pinnable: boolean;
  onActivate: () => void;
  onPick: () => void;
  onTogglePin: () => void;
}) {
  const frozen = project.archivedAt != null;
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
        PROJECT_ROW,
        'group/row cursor-pointer',
        'aria-selected:bg-well-800',
        'aria-[current]:bg-accent/10 aria-[current]:text-ink-bright aria-[current]:inset-ring aria-[current]:inset-ring-accent/28',
        frozen && 'text-ink-ghost',
      )}
    >
      <ProjectRowContent project={project} decisions={decisions} />
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

/**
 * Toggle a project's pin, announcing the change politely. Archived projects
 * cannot be written, and nothing saves offline; `toggle` says whether it wrote.
 */
export function usePinToggle(offline: boolean): {
  announcement: string;
  toggle: (project: EngineNode) => boolean;
} {
  const pin = usePinProject();
  const [announcement, setAnnouncement] = useState('');
  const toggle = (project: EngineNode) => {
    if (offline || project.archivedAt != null) {
      return false;
    }
    const next = project.pinned !== true;
    pin.mutate({ key: project.id, pinned: next });
    setAnnouncement(`${next ? 'Pinned' : 'Unpinned'} ${project.id}`);
    return true;
  };
  return { announcement, toggle };
}

/**
 * The keys of a project listbox. Focus stays in the search box; the arrows
 * move the highlight through `keys`, wrapping, Enter picks it, and Alt+P
 * toggles its pin. The highlight follows its key while the list reorders or
 * refreshes, and falls back to the first row when that key is filtered out.
 * Until moved, it rests on `restingKey`, or on the first row when that is not
 * listed. A pin keeps the highlight on its project as the list reorders.
 */
export function useProjectListbox({
  keys,
  restingKey,
  onPick,
  onTogglePin,
}: {
  keys: readonly string[];
  restingKey: string;
  onPick: (key: string) => void;
  /** Toggle the pin of the project `key`; true when it wrote. */
  onTogglePin: (key: string) => boolean;
}) {
  const listId = useId();
  // Null means untouched: the highlight rests on `restingKey`.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const activeIndex = Math.max(0, keys.indexOf(activeKey ?? restingKey));
  const activeOption = keys.at(activeIndex);
  const optionId = (key: string) => `${listId}-${key === ALL_PROJECTS_KEY ? 'all' : key}`;
  const activeOptionId = activeOption === undefined ? undefined : optionId(activeOption);

  // The input keeps focus, so the list scrolls the highlighted row into view.
  useEffect(() => {
    if (activeOptionId !== undefined) {
      document.getElementById(activeOptionId)?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeOptionId]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.altKey && event.code === 'KeyP') {
      event.preventDefault();
      if (activeOption !== undefined && onTogglePin(activeOption)) {
        setActiveKey(activeOption);
      }
      return;
    }
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (step !== undefined) {
      event.preventDefault();
      setActiveKey(keys.at((activeIndex + step) % keys.length) ?? null);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (activeOption !== undefined) {
        onPick(activeOption);
      }
    }
  };

  return { activeOption, activeOptionId, listId, onKeyDown, optionId, setActiveKey };
}
