import { Dialog } from '@base-ui-components/react/dialog';
import type { EngineTree } from '@mimir/contract';
import { useQuery } from '@tanstack/react-query';
import { Link, useLinkProps, useRouterState } from '@tanstack/react-router';
import { useId, useState } from 'react';

import { pendingPairingsQuery } from '../api/device-queries';
import { nodeQuery } from '../api/node-queries';
import { treeQuery } from '../api/shell-queries';
import { cn } from '../lib/cn';
import { isSectionPage, openRecordId, sectionOfPath } from '../lib/project-sidebar';
import type { SidebarContext } from '../lib/project-sidebar';
import { nodeLink } from '../lib/record-url';
import { useArchivedProject } from '../lib/use-archived-project';
import { buildOutline } from '../lib/work-page';
import type { FinishedInitiative, OutlineEntry, OutlineTally } from '../lib/work-page';
import { ProjectPicker } from './project-picker';
import { SidebarProjects } from './sidebar-projects';
import { StatusDot } from './status-dot';
import { iconButtonClass } from './ui/icon-button';
import { ChevronRightIcon, MenuIcon } from './ui/icons';
import { Skeleton } from './ui/skeleton';

/*
 * The shell's project sidebar (ADR 0013, MMR-492 refinement): the current
 * project's switcher header, its sections, and its initiative and phase
 * outline, which marks the open record's place. Outside a project (`/`,
 * `/doctor`) its context is All projects (MMR-505): a header reading so, Work,
 * which is `/`, and the Projects section of pinned projects (MMR-562,
 * MMR-567). On Settings' pages and `/pair` it lists Settings' pages instead
 * (MMR-733). From `lg` up it sits beside the page; below that it
 * folds into a drawer behind a top-bar button, because a record page's own
 * rail needs the width a tablet has.
 */

/**
 * The selection treatment (ADR 0019): the accent as a low-alpha wash with a
 * hairline inset ring, never a solid fill. Sections key it on any
 * `aria-current`, rows on `page`.
 */
const SECTION_CURRENT =
  'aria-[current]:bg-accent/10 aria-[current]:text-ink-bright aria-[current]:inset-ring aria-[current]:inset-ring-accent/28';
const ROW_CURRENT =
  'aria-[current=page]:bg-accent/10 aria-[current=page]:text-ink-bright aria-[current=page]:inset-ring aria-[current=page]:inset-ring-accent/28';

const ROW =
  'flex min-w-0 items-center gap-2 rounded-md px-2 text-ink transition-colors hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent';

/**
 * Every row in the drawer, below `lg`, is a 44 tap row (DESIGN.md, Sizes:
 * every tap target on a phone is at least 44 × 44); from `lg` up the sidebar
 * keeps its compact rows.
 */
const DRAWER_TAP_ROW = 'max-lg:min-h-11';

/** A section's row: Work, a browser, a Settings page, the way back to work. */
const SECTION_ROW = cn(ROW, 'py-1.5 text-meta', DRAWER_TAP_ROW);

/** Work is the project's page; its outline sits under it. `to` is the section's route. */
const WORK = { label: 'Work', section: 'work', to: '/p/$key' } as const;

/** The project's browsers, below the outline. */
const BROWSERS = [
  { label: 'Tasks', section: 'tasks', to: '/p/$key/tasks' },
  { label: 'Seeds', section: 'seeds', to: '/p/$key/seeds' },
  { label: 'Artifacts', section: 'artifacts', to: '/p/$key/artifacts' },
] as const;

type SectionEntry = typeof WORK | (typeof BROWSERS)[number];

/**
 * A section link. It is the page (`aria-current="page"`) only on its own route.
 * On a record inside it, the record's outline row is the page and the section
 * is just the current one (`aria-current="true"`), so a screen reader hears one
 * page, not two. The router would call both "page", so the props are its own
 * with `aria-current` replaced.
 */
function SectionLink({
  entry,
  projectKey,
  current,
  onNavigate,
}: {
  entry: SectionEntry;
  projectKey: string;
  current: 'page' | 'true' | undefined;
  onNavigate?: () => void;
}) {
  const linkProps = useLinkProps({
    activeOptions: { exact: true, includeSearch: false },
    onClick: onNavigate,
    params: { key: projectKey },
    to: entry.to,
  });
  return (
    <a {...linkProps} aria-current={current} className={cn(SECTION_ROW, SECTION_CURRENT)}>
      {entry.label}
    </a>
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
 * outline, and say so in words for a screen reader.
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
        DRAWER_TAP_ROW,
        'rounded-sm py-1 text-xs data-[on-path]:text-ink-bright data-[on-path]:inset-ring data-[on-path]:inset-ring-accent/28',
        ROW_CURRENT,
      )}
      style={{ marginLeft: `${String(entry.depth * 0.75)}rem` }}
    >
      <StatusDot status={entry.status} />
      <span className="min-w-0 flex-1 truncate">{entry.title}</span>
      {entry.mark === 'path' && <span className="sr-only">, contains this page</span>}
      {tally !== '' && (
        <span className="shrink-0 font-mono text-mono-id text-ink-dim">{tally}</span>
      )}
    </Link>
  );
}

/**
 * Whether a fold is open: `initial` at first, and again whenever `resetKey`
 * changes, with the reader's own toggles in between. The sidebar outlives page
 * changes, so a fold keys this on the open record and re-asserts its starting
 * state on each navigation without remounting, which keeps a focused row.
 */
function useFoldState(initial: boolean, resetKey: string) {
  const [open, setOpen] = useState(initial);
  const [seenKey, setSeenKey] = useState(resetKey);
  if (seenKey !== resetKey) {
    setSeenKey(resetKey);
    setOpen(initial);
  }
  return [open, setOpen] as const;
}

/**
 * The disclosure beside a finished initiative's row, and the gap that stands
 * in for it: 24 wide beside the sidebar, 44 in the drawer, where its height is
 * the row's 44. The rows inside it indent by the same width.
 */
const DISCLOSURE_WIDTH = 'w-6 max-lg:w-11';

/**
 * A finished initiative inside the fold: its row, and a toggle that shows the
 * rows inside it. It starts shut unless the open record is the initiative or
 * sits inside it, and each navigation re-asserts that.
 */
function FinishedInitiativeRows({
  initiative,
  openId,
  onNavigate,
}: {
  initiative: FinishedInitiative;
  openId: string | undefined;
  onNavigate?: () => void;
}) {
  const { row, inside, holdsOpen } = initiative;
  const [open, setOpen] = useFoldState(holdsOpen, `${openId ?? ''}:${String(holdsOpen)}`);
  const insideId = useId();
  return (
    <>
      <div className="flex min-w-0 items-center">
        {inside.length > 0 ? (
          <button
            type="button"
            aria-label={`Contents of ${row.title}`}
            aria-expanded={open}
            aria-controls={open ? insideId : undefined}
            onClick={() => {
              setOpen((v) => !v);
            }}
            className={cn(
              'flex shrink-0 items-center justify-center self-stretch rounded-sm text-ink-dim transition-colors hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent',
              DISCLOSURE_WIDTH,
            )}
          >
            <ChevronRightIcon
              className={cn(
                'size-3 transition-transform [stroke-width:2.5] md:size-3',
                open && 'rotate-90',
              )}
            />
          </button>
        ) : (
          <span aria-hidden="true" className={cn('shrink-0', DISCLOSURE_WIDTH)} />
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <OutlineRow entry={row} onNavigate={onNavigate} />
        </div>
      </div>
      {open && (
        <div id={insideId} className="ml-6 flex flex-col gap-px max-lg:ml-11">
          {inside.map((entry) => (
            <OutlineRow key={entry.id} entry={entry} onNavigate={onNavigate} />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * The finished top-level initiatives, in one disclosure that starts shut unless
 * the open record sits inside one of them; each navigation re-asserts that.
 */
function FinishedFold({
  finished,
  openId,
  onNavigate,
}: {
  finished: FinishedInitiative[];
  openId: string | undefined;
  onNavigate?: () => void;
}) {
  const insideFold = finished.some((f) => f.holdsOpen);
  const [open, setOpen] = useFoldState(insideFold, `${openId ?? ''}:${String(insideFold)}`);
  return (
    <details
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      {/* A summary keeps its list-item display for the marker, so its 44 comes
          from padding: the 16 line and 14 above and below. */}
      <summary className="cursor-pointer rounded-sm px-2 py-1 text-xs text-ink-dim focus-visible:outline-2 focus-visible:outline-accent max-lg:py-3.5">
        {finished.length} finished {finished.length === 1 ? 'initiative' : 'initiatives'}
      </summary>
      <div className="flex flex-col gap-px">
        {finished.map((initiative) => (
          <FinishedInitiativeRows
            key={initiative.row.id}
            initiative={initiative}
            openId={openId}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </details>
  );
}

/**
 * The project's initiatives and phases, each at its own page with its progress,
 * and the open record's place marked. Finished top-level initiatives fold into
 * one disclosure, and each of them folds on its own inside it; both open when
 * the record sits inside one.
 */
function Outline({
  tree,
  unavailable,
  openId,
  onNavigate,
}: {
  tree: EngineTree | undefined;
  unavailable: boolean;
  openId: string | undefined;
  onNavigate?: () => void;
}) {
  if (tree === undefined) {
    return unavailable ? (
      <p className="px-2 py-1 text-xs text-ink-dim">Couldn’t load the structure.</p>
    ) : (
      <Skeleton className="mx-2 my-1 h-16" />
    );
  }
  const outline = buildOutline(tree, openId);
  return (
    <nav aria-label="Outline" className="mb-1 ml-2.5 flex flex-col gap-px">
      {outline.entries.length === 0 && outline.finished.length === 0 && (
        <p className="px-2 py-1 text-xs text-ink-dim">No initiatives or phases.</p>
      )}
      {outline.entries.map((entry) => (
        <OutlineRow key={entry.id} entry={entry} onNavigate={onNavigate} />
      ))}
      {outline.finished.length > 0 && (
        <FinishedFold finished={outline.finished} openId={openId} onNavigate={onNavigate} />
      )}
    </nav>
  );
}

/**
 * A project's sidebar content: the switcher header, then Work with the outline
 * under it, then the browsers. `onNavigate` fires when a pick moves the page,
 * so the drawer can close behind it.
 */
function ProjectBody({ projectKey, onNavigate }: { projectKey: string; onNavigate?: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // The tree is the whole board, so it is read once rather than polled, as on
  // the record pages; a console write invalidates it.
  // An archived project's tree 404s (ADR 0015), and so do its browsers: the
  // sidebar offers only Work, which is the page that says so and can undo it.
  const archived = useArchivedProject(projectKey);
  const tree = useQuery({
    ...treeQuery(projectKey),
    enabled: archived === undefined,
    refetchInterval: false,
  });
  const openId = openRecordId(pathname);
  // The page reads this record already, so it is in the cache: a task's page is
  // Tasks as soon as the record lands, and whether or not the tree does.
  const record = useQuery({ ...nodeQuery(openId ?? ''), enabled: openId !== undefined });
  const here = sectionOfPath(pathname, record.data?.type);
  const onOwnPage = isSectionPage(pathname);
  const sectionLink = (entry: SectionEntry) => {
    let current: 'page' | 'true' | undefined;
    if (here === entry.section) {
      current = onOwnPage ? 'page' : 'true';
    }
    return (
      <SectionLink
        key={entry.section}
        entry={entry}
        projectKey={projectKey}
        current={current}
        onNavigate={onNavigate}
      />
    );
  };
  if (archived !== undefined) {
    return sectionLink(WORK);
  }
  return (
    <>
      {sectionLink(WORK)}
      <Outline
        tree={tree.data}
        unavailable={tree.isError}
        openId={openId}
        onNavigate={onNavigate}
      />
      {BROWSERS.map(sectionLink)}
    </>
  );
}

/** The All projects sidebar content: Work, which is `/`, then the Projects section (MMR-562). */
function AllProjectsBody({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      <Link
        to="/"
        activeOptions={{ exact: true, includeSearch: false }}
        onClick={onNavigate}
        className={cn(SECTION_ROW, SECTION_CURRENT)}
      >
        Work
      </Link>
      <SidebarProjects onNavigate={onNavigate} />
    </>
  );
}

type SettingsTo =
  | '/settings/notifications'
  | '/settings/appearance'
  | '/settings/devices'
  | '/settings/connections'
  | '/settings/about';

/**
 * A Settings page's link. The current page takes the selection treatment. On
 * `/pair`, which approves a request, Devices is the current section
 * (`aria-current="true"`), as a project's section is on one of its records.
 * `count` is a number that needs the operator, in the attention color.
 */
function SettingsLink({
  to,
  label,
  count,
  onNavigate,
}: {
  to: SettingsTo;
  label: string;
  count?: number;
  onNavigate?: () => void;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const linkProps = useLinkProps({
    activeOptions: { exact: true, includeSearch: false },
    onClick: onNavigate,
    to,
  });
  let current: 'page' | 'true' | undefined;
  if (pathname === to) {
    current = 'page';
  } else if (to === '/settings/devices' && pathname === '/pair') {
    current = 'true';
  }
  return (
    <a {...linkProps} aria-current={current} className={cn(SECTION_ROW, SECTION_CURRENT)}>
      {label}
      {count !== undefined && count > 0 && (
        <>
          <span aria-hidden className="ml-auto font-semibold text-attention-foreground">
            {count}
          </span>
          <span className="sr-only">, {count} waiting</span>
        </>
      )}
    </a>
  );
}

function SettingsGroupHeading({ children }: { children: string }) {
  return <p className="microlabel mt-3 mb-1 px-2 text-ink-dim">{children}</p>;
}

/**
 * The Settings sidebar content (MMR-733): the way back to work, then the pages
 * in "This device" and "Host", with the pairing requests waiting beside Devices.
 */
function SettingsBody({ onNavigate }: { onNavigate?: () => void }) {
  const waiting = useQuery(pendingPairingsQuery).data?.length;
  return (
    <>
      <Link to="/" onClick={onNavigate} className={cn(SECTION_ROW, 'text-ink-dim')}>
        ← Back to work
      </Link>
      <SettingsGroupHeading>This device</SettingsGroupHeading>
      <SettingsLink to="/settings/notifications" label="Notifications" onNavigate={onNavigate} />
      <SettingsLink to="/settings/appearance" label="Appearance" onNavigate={onNavigate} />
      <SettingsGroupHeading>Host</SettingsGroupHeading>
      <SettingsLink
        to="/settings/devices"
        label="Devices"
        count={waiting}
        onNavigate={onNavigate}
      />
      <SettingsLink to="/settings/connections" label="Connections" onNavigate={onNavigate} />
      <SettingsLink to="/settings/about" label="About" onNavigate={onNavigate} />
    </>
  );
}

/** What the sidebar's landmarks and drawer are called: the context they frame. */
function landmarkLabel(context: SidebarContext): string {
  switch (context.kind) {
    case 'all': {
      return 'All projects';
    }
    case 'settings': {
      return 'Settings';
    }
    default: {
      return 'Project';
    }
  }
}

/** The sidebar's content for its context: the switcher header, then the context's sections. */
function SidebarBody({
  context,
  onNavigate,
}: {
  context: SidebarContext;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label={landmarkLabel(context)} className="flex flex-col gap-0.5">
      {context.kind !== 'settings' && (
        <div className="mb-2">
          <ProjectPicker context={context} onNavigate={onNavigate} />
        </div>
      )}
      {context.kind === 'project' && (
        <ProjectBody projectKey={context.key} onNavigate={onNavigate} />
      )}
      {context.kind === 'all' && <AllProjectsBody onNavigate={onNavigate} />}
      {context.kind === 'settings' && <SettingsBody onNavigate={onNavigate} />}
    </nav>
  );
}

/** The desktop sidebar: a fixed-width column beside the page. */
export function ProjectSidebar({ context }: { context: SidebarContext }) {
  return (
    <aside
      aria-label={landmarkLabel(context)}
      className="w-64 shrink-0 overflow-y-auto border-r border-line bg-well-950 p-2.5"
    >
      <SidebarBody context={context} />
    </aside>
  );
}

/**
 * The compact sidebar: a button for the top bar that opens the same content as
 * a drawer from the left. Escape or a tap on the scrim closes it and hands
 * focus back to the button; choosing something, or any other move to another
 * page (Back, the jump palette), closes it too.
 */
export function ProjectDrawer({ context }: { context: SidebarContext }) {
  const [open, setOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setOpen(false);
  }
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        aria-label={context.kind === 'settings' ? 'Open settings menu' : 'Open project menu'}
        className={iconButtonClass}
      >
        <MenuIcon />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop
          data-testid="project-drawer-scrim"
          className="fixed inset-0 z-40 bg-well-950/60 transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0"
        />
        <Dialog.Popup
          aria-label={landmarkLabel(context)}
          className="fixed inset-y-0 left-0 z-50 w-[300px] max-w-[88vw] overflow-y-auto border-r border-line bg-well-950 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-2xl outline-none transition-transform duration-200 ease-out data-[ending-style]:-translate-x-full data-[starting-style]:-translate-x-full"
        >
          <SidebarBody
            context={context}
            onNavigate={() => {
              setOpen(false);
            }}
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
