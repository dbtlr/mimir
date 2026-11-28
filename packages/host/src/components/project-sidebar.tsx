import { useQuery } from '@tanstack/react-query';
import { Link, useLinkProps, useRouterState } from '@tanstack/react-router';
import { useRef, useState } from 'react';

import { pendingPairingsQuery } from '../api/device-queries';
import { cn } from '../lib/cn';
import type { SidebarContext } from '../lib/project-sidebar';
import { DRAWER_TAP_ROW } from '../lib/touch-target';
import { SidebarJumpTo, useOpenJumpPalette } from './jump-palette';
import { NavigationDrawer } from './patterns/navigation-drawer';
import { ProjectPicker } from './project-picker';
import { ProjectContainers } from './sidebar-containers';
import { ProjectNeedsYou } from './sidebar-needs-you';
import { HomeContainers } from './sidebar-projects';
import { ROW_CURRENT, ROW_HOLDS } from './sidebar-selection';

/*
 * The shell's sidebar (ADR 0013; the MMR-730 and MMR-804 refinements): Jump
 * to (MMR-729), the switcher, on a project's pages what needs you there, then
 * one container list, a link to the parent, the current container, and its
 * child containers. Outside a project its context is All
 * projects (MMR-505), where the list is Home and the projects. On Settings'
 * pages and `/pair` it lists Settings' pages instead (MMR-733). From `lg` up
 * it sits beside the page; below that it folds into a drawer behind a top-bar
 * button, because a record page's own rail needs the width a tablet has.
 */

/** A Settings row: a page, or the way back to work. */
const SECTION_ROW = cn(
  'flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-meta text-ink transition-colors hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent',
  DRAWER_TAP_ROW,
);

type SettingsTo =
  | '/settings/notifications'
  | '/settings/appearance'
  | '/settings/devices'
  | '/settings/connections'
  | '/settings/about';

/**
 * A Settings page's link. The current page takes the selection treatment. On
 * `/pair`, which approves a request, Devices is the current section
 * (`aria-current="true"`) and holds the page, ringed as a container's row is
 * on a page it holds.
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
    <a
      {...linkProps}
      aria-current={current}
      data-holds={current === 'true' ? 'true' : undefined}
      className={cn(SECTION_ROW, ROW_CURRENT, ROW_HOLDS)}
    >
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

/**
 * The sidebar's content for its context: Jump to, the switcher, the
 * project's Needs you slot, then the context's container list (or Settings'
 * pages). In the drawer, `onJump` closes it before the palette
 * opens.
 */
function SidebarBody({
  context,
  onNavigate,
  onJump,
}: {
  context: SidebarContext;
  onNavigate?: () => void;
  onJump?: () => void;
}) {
  return (
    <nav aria-label={landmarkLabel(context)} className="flex flex-col gap-0.5">
      <SidebarJumpTo onJump={onJump} />
      {context.kind !== 'settings' && (
        <div className="mb-3.5">
          <ProjectPicker context={context} onNavigate={onNavigate} />
        </div>
      )}
      {context.kind === 'project' && (
        <ProjectNeedsYou projectKey={context.key} onNavigate={onNavigate} />
      )}
      {context.kind !== 'settings' && (
        <div className="flex flex-col gap-px">
          {context.kind === 'project' ? (
            <ProjectContainers projectKey={context.key} onNavigate={onNavigate} />
          ) : (
            <HomeContainers onNavigate={onNavigate} />
          )}
        </div>
      )}
      {context.kind === 'settings' && <SettingsBody onNavigate={onNavigate} />}
    </nav>
  );
}

/** The desktop sidebar: a fixed-width column beside the page. */
export function ProjectSidebar({ context }: { context: SidebarContext }) {
  return (
    <aside
      aria-label={landmarkLabel(context)}
      className="w-64 shrink-0 overflow-y-auto border-r border-line bg-well-950 p-3"
    >
      <SidebarBody context={context} />
    </aside>
  );
}

/**
 * The compact sidebar: a button for the top bar that opens the same content as
 * a drawer from the left. Escape, a tap on the scrim, or a drag toward the
 * left edge closes it and hands focus back to the button; choosing something,
 * or any other move to another page or through history (Back, the jump
 * palette, Back between two tabs), closes it too. Its Jump to closes the drawer first and opens the
 * palette once the close has finished, handing it the menu button, so the
 * palette returns focus there when it closes.
 */
export function ProjectDrawer({ context }: { context: SidebarContext }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const jumpPending = useRef(false);
  const openPalette = useOpenJumpPalette();
  // A new page, a new fragment, or a step through history (Back between two
  // tabs of one page) closes it; a page rewriting its own query in place (a
  // replace, which keeps the history index) leaves it open. The fragment is in
  // the key because a browser gives a fragment's entry no state, so Back from
  // an in-page link keeps the index.
  const place = useRouterState({
    select: (s) =>
      `${s.location.pathname}#${s.location.hash} ${String(s.location.state.__TSR_index)}`,
  });
  const [seenPlace, setSeenPlace] = useState(place);
  if (seenPlace !== place) {
    setSeenPlace(place);
    setOpen(false);
  }
  return (
    <NavigationDrawer
      open={open}
      onOpenChange={(next) => {
        // Reopened before its close finished: the Jump to it was closing for is dropped.
        if (next) {
          jumpPending.current = false;
        }
        setOpen(next);
      }}
      onClosed={() => {
        if (jumpPending.current) {
          jumpPending.current = false;
          openPalette(trigger.current);
        }
      }}
      triggerRef={trigger}
      triggerLabel={context.kind === 'settings' ? 'Open settings menu' : 'Open project menu'}
      label={landmarkLabel(context)}
    >
      <SidebarBody
        context={context}
        onNavigate={() => {
          setOpen(false);
        }}
        onJump={() => {
          jumpPending.current = true;
          setOpen(false);
        }}
      />
    </NavigationDrawer>
  );
}
