import { Dialog } from '@base-ui-components/react/dialog';
import { useQuery } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import { useState } from 'react';

import { treeQuery } from '../api/queries';
import type { WireTreeNode } from '../api/types';
import { subtreeOf } from '../lib/ancestry';
import { cn } from '../lib/cn';
import { openRecordId, sectionOfPath } from '../lib/project-sidebar';
import { nodeLink } from '../lib/record-url';
import { buildOutline } from '../lib/work-page';
import type { OutlineEntry, OutlineTally } from '../lib/work-page';
import { ProjectPicker } from './project-picker';
import { StatusDot } from './status-dot';
import { Skeleton } from './ui/skeleton';

/*
 * The shell's project sidebar (ADR 0013, MMR-492 refinement): the current
 * project's switcher header, its sections, and its initiative and phase
 * outline, which marks the open record's place. A desktop shows it beside the
 * page; a phone folds it into a drawer behind a top-bar button.
 */

/**
 * The selection treatment (ADR 0019): the accent as a low-alpha wash with a
 * hairline inset ring, never a solid fill. Keyed on `aria-current`, which the
 * router sets and the sidebar sets by hand where the page is not the link's own
 * route (a task's page marks Tasks).
 */
const CURRENT =
  'aria-[current=page]:bg-accent/10 aria-[current=page]:text-ink-bright aria-[current=page]:inset-ring aria-[current=page]:inset-ring-accent/28';

const ROW =
  'flex min-w-0 items-center gap-2 rounded-md px-2 text-ink transition-colors hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent';

/** Work is the project's page; its outline sits under it. `to` is the section's route. */
const WORK = { label: 'Work', section: 'work', to: '/p/$key' } as const;

/** The project's browsers, below the outline. */
const BROWSERS = [
  { label: 'Tasks', section: 'tasks', to: '/p/$key/tasks' },
  { label: 'Seeds', section: 'seeds', to: '/p/$key/seeds' },
  { label: 'Artifacts', section: 'artifacts', to: '/p/$key/artifacts' },
] as const;

type SectionEntry = typeof WORK | (typeof BROWSERS)[number];

function SectionLink({
  entry,
  projectKey,
  current,
  onNavigate,
}: {
  entry: SectionEntry;
  projectKey: string;
  current: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      to={entry.to}
      params={{ key: projectKey }}
      // The route alone cannot say: a task's page is Tasks, a phase's is Work.
      activeOptions={{ exact: true, includeSearch: false }}
      aria-current={current ? 'page' : undefined}
      onClick={onNavigate}
      className={cn(ROW, 'py-1.5 text-meta max-md:py-2.5', CURRENT)}
    >
      {entry.label}
    </Link>
  );
}

/** What an outline row shows at its right edge: done over total, ∞, parked, or nothing. */
function tallyText(tally: OutlineTally): string {
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
    case 'none': {
      return '';
    }
    default: {
      const _exhaustive: never = tally;
      return _exhaustive;
    }
  }
}

/**
 * An outline row. The open record's own row is the page (accent wash); the
 * containers above it carry a ring alone, so the record's place reads down the
 * outline.
 */
function OutlineRow({ entry, onNavigate }: { entry: OutlineEntry; onNavigate?: () => void }) {
  const tally = tallyText(entry.tally);
  return (
    <Link
      {...nodeLink(entry.id)}
      activeOptions={{ exact: true, includeSearch: false }}
      aria-current={entry.mark === 'current' ? 'page' : undefined}
      data-on-path={entry.mark === 'path' ? 'true' : undefined}
      onClick={onNavigate}
      className={cn(
        ROW,
        'rounded-sm py-1 text-xs max-md:py-2 data-[on-path]:text-ink-bright data-[on-path]:inset-ring data-[on-path]:inset-ring-accent/28',
        CURRENT,
      )}
      style={{ marginLeft: `${String(entry.depth * 0.75)}rem` }}
    >
      <StatusDot status={entry.status} />
      <span className="min-w-0 flex-1 truncate">{entry.title}</span>
      {tally !== '' && (
        <span className="shrink-0 font-mono text-mono-id text-ink-faint">{tally}</span>
      )}
    </Link>
  );
}

/**
 * The project's initiatives and phases, each at its own page with its progress,
 * and the open record's place marked. Finished top-level initiatives fold into
 * one disclosure, open when the record sits inside one.
 */
function Outline({
  tree,
  unavailable,
  openId,
  onNavigate,
}: {
  tree: WireTreeNode | undefined;
  unavailable: boolean;
  openId: string | undefined;
  onNavigate?: () => void;
}) {
  if (tree === undefined) {
    return unavailable ? (
      <p className="px-2 py-1 text-xs text-ink-faint">Couldn’t load the structure.</p>
    ) : (
      <Skeleton className="mx-2 my-1 h-16" />
    );
  }
  const outline = buildOutline(tree, openId);
  const insideFold = outline.finished.entries.some((e) => e.mark !== undefined);
  return (
    <nav aria-label="Outline" className="mb-1 ml-2.5 flex flex-col gap-px">
      {outline.entries.length === 0 && outline.finished.count === 0 && (
        <p className="px-2 py-1 text-xs text-ink-faint">No initiatives or phases.</p>
      )}
      {outline.entries.map((entry) => (
        <OutlineRow key={entry.id} entry={entry} onNavigate={onNavigate} />
      ))}
      {outline.finished.count > 0 && (
        <details open={insideFold}>
          <summary className="cursor-pointer rounded-sm px-2 py-1 text-xs text-ink-faint focus-visible:outline-2 focus-visible:outline-accent max-md:py-2">
            {outline.finished.count} finished{' '}
            {outline.finished.count === 1 ? 'initiative' : 'initiatives'}
          </summary>
          {outline.finished.entries.map((entry) => (
            <OutlineRow key={entry.id} entry={entry} onNavigate={onNavigate} />
          ))}
        </details>
      )}
    </nav>
  );
}

/**
 * The sidebar's content: the switcher header, then Work with the outline under
 * it, then the browsers. `onNavigate` fires when a pick moves the page, so the
 * drawer can close behind it.
 */
function SidebarBody({ projectKey, onNavigate }: { projectKey: string; onNavigate?: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // The tree is the whole board, so it is read once rather than polled, as on
  // the record pages; a console write invalidates it.
  const tree = useQuery({ ...treeQuery(projectKey), refetchInterval: false });
  const openId = openRecordId(pathname);
  const openType =
    openId === undefined || tree.data === undefined
      ? undefined
      : subtreeOf(tree.data, openId)?.type;
  const here = sectionOfPath(pathname, openType);
  const sectionLink = (entry: SectionEntry) => (
    <SectionLink
      key={entry.section}
      entry={entry}
      projectKey={projectKey}
      current={here === entry.section}
      onNavigate={onNavigate}
    />
  );
  return (
    <nav aria-label="Project" className="flex flex-col gap-0.5">
      <div className="mb-2">
        <ProjectPicker projectKey={projectKey} onNavigate={onNavigate} />
      </div>
      {sectionLink(WORK)}
      <Outline
        tree={tree.data}
        unavailable={tree.isError}
        openId={openId}
        onNavigate={onNavigate}
      />
      {BROWSERS.map(sectionLink)}
    </nav>
  );
}

/** The desktop sidebar: a fixed-width column beside the page. */
export function ProjectSidebar({ projectKey }: { projectKey: string }) {
  return (
    <aside className="w-64 shrink-0 overflow-y-auto border-r border-line bg-well-950 p-2.5">
      <SidebarBody projectKey={projectKey} />
    </aside>
  );
}

/**
 * The phone sidebar: a button for the top bar that opens the same content as a
 * drawer from the left. Escape or a tap on the scrim closes it and hands focus
 * back to the button; choosing something closes it too.
 */
export function ProjectDrawer({ projectKey }: { projectKey: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        aria-label="Open project menu"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded text-ink-dim transition-colors hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop
          data-testid="project-drawer-scrim"
          className="fixed inset-0 z-40 bg-well-950/60 transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0"
        />
        <Dialog.Popup
          aria-label="Project"
          className="fixed inset-y-0 left-0 z-50 w-[300px] max-w-[88vw] overflow-y-auto border-r border-line bg-well-950 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-2xl outline-none transition-transform duration-200 ease-out data-[ending-style]:-translate-x-full data-[starting-style]:-translate-x-full"
        >
          <SidebarBody
            projectKey={projectKey}
            onNavigate={() => {
              setOpen(false);
            }}
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
