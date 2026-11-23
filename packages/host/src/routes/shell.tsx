import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';

import { AttentionAlert } from '../components/attention-alert';
import { BrandMark } from '../components/brand-mark';
import { JumpPalette } from '../components/jump-palette';
import { PreviewRoomProvider, usePreviewRoomOpen } from '../components/patterns/feed/preview-room';
import { NoticeHost } from '../components/patterns/notice';
import { ProjectDrawer, ProjectSidebar } from '../components/project-sidebar';
import { PushHealer } from '../components/push-healer';
import { PwaUpdateBanner } from '../components/pwa-update-banner';
import { PwaUpdateProvider } from '../components/pwa-update-provider';
import { SeedCaptureProvider } from '../components/seed-capture';
import { TopBarMore } from '../components/top-bar-more';
import { VersionFooter } from '../components/version-footer';
import { useCurrentProjectKey, useRememberCurrentProject } from '../lib/current-project';
import { focusMain } from '../lib/focus-main';
import { isSettingsPath, sidebarContextOf } from '../lib/project-sidebar';
import { useMediaQuery } from '../lib/use-media-query';
import { useTheme } from '../lib/use-theme';
import { useOpenerFocus } from '../lib/walkthrough-mark';

/**
 * Tailwind's `lg`: from here up the project sidebar sits beside the page; below
 * it, a drawer. Between `md` and `lg` a record page's own 300px rail would
 * leave the content about 160px beside a 256px sidebar.
 */
export const DESKTOP = '(min-width: 1024px)';

/** From here up the sidebar stays beside an open preview panel, and the column re-centres instead. */
const WIDE = '(min-width: 1600px)';

/** The element's height in pixels, kept as it resizes (the top bar grows under a status bar). */
function useHeight(element: RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const node = element.current;
    if (node === null) {
      return undefined;
    }
    const measure = () => {
      setHeight(node.getBoundingClientRect().height);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [element]);
  return height;
}

/**
 * The first stop for a keyboard: jumps past the top bar and the sidebar to the
 * page's `<main>`, which takes focus.
 */
function SkipLink() {
  return (
    <a
      href="#main"
      onClick={(event) => {
        event.preventDefault();
        focusMain();
      }}
      className="sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:top-2 focus-visible:left-2 focus-visible:z-50 focus-visible:rounded focus-visible:bg-well-850 focus-visible:px-3 focus-visible:py-1.5 focus-visible:text-meta focus-visible:text-ink-bright focus-visible:inset-ring focus-visible:inset-ring-accent"
    >
      Skip to content
    </a>
  );
}

/**
 * The app shell (ADR 0013, MMR-492 refinement): a slim top bar (brand, jump
 * palette, Needs you, the "…" menu), the sidebar (the page's project, Settings
 * on its pages, or All projects outside both), and the routed surface. At every
 * width Settings, the theme switch, and the update action sit in the "…" menu
 * (MMR-715, MMR-733).
 */
export function Shell() {
  return (
    <PwaUpdateProvider>
      <PreviewRoomProvider>
        <ShellContent />
      </PreviewRoomProvider>
    </PwaUpdateProvider>
  );
}

function ShellContent() {
  const { theme, toggle } = useTheme();
  useOpenerFocus();
  const desktop = useMediaQuery(DESKTOP);
  useRememberCurrentProject();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // With no project there is nothing to frame: Home at / handles
  // creating the first one. The remembered project only decides that a project
  // exists; the sidebar's context comes from the page (MMR-505).
  const framed = useCurrentProjectKey() !== undefined;
  // Settings is framed with no project too: pairing a device comes first.
  const context = framed || isSettingsPath(pathname) ? sidebarContextOf(pathname) : undefined;
  const sidebarShown = context !== undefined && desktop;
  const topBar = useRef<HTMLElement>(null);
  // The phone's toasts sit under the top bar, at its measured height.
  const topBarHeight = useHeight(topBar);
  const footer = useRef<HTMLElement>(null);
  // The desktop's toasts sit 20 above the content area, past the version footer's strip.
  const footerHeight = useHeight(footer);
  const shellStyle: CSSProperties & Record<'--top-bar-height' | '--version-footer-height', string> =
    {
      '--top-bar-height': `${String(topBarHeight)}px`,
      '--version-footer-height': `${String(footerHeight)}px`,
    };
  return (
    <SeedCaptureProvider>
      <PushHealer />
      <div className="flex h-dvh flex-col overflow-hidden" style={shellStyle}>
        <SkipLink />
        {/* Solid well-950, the top bar's own ground, which the browser chrome
          also takes (theme-color): a translucent bar here let the status bar
          fade into it. The safe-area pad keeps the bar's ground under a status
          bar that overlays the page. */}
        <header
          ref={topBar}
          className="z-20 flex items-center gap-2 border-b border-line bg-well-950 px-4 pt-[calc(0.5rem+env(safe-area-inset-top))] pb-2 max-lg:px-2 max-md:gap-1"
        >
          {context !== undefined && !desktop && <ProjectDrawer context={context} />}
          <Link
            to="/"
            className="flex items-center gap-2 rounded font-mono text-[15px] font-bold max-md:ml-1 tracking-tight text-ink-bright focus-visible:outline-2 focus-visible:outline-accent"
          >
            <BrandMark />
            Mimir
          </Link>
          <div className="ml-auto flex items-center gap-1">
            <JumpPalette />
            <AttentionAlert />
            <TopBarMore theme={theme} onToggleTheme={toggle} />
          </div>
        </header>
        <ShellColumns sidebar={sidebarShown ? <ProjectSidebar context={context} /> : undefined}>
          <PwaUpdateBanner />
          <Outlet />
          <VersionFooter ref={footer} />
        </ShellColumns>
      </div>
    </SeedCaptureProvider>
  );
}

/**
 * The sidebar beside the routed surface, and the Notice host. While a preview
 * panel is open (ADR 0019, MMR-720 refinement) the content reserves the
 * panel's 440 at its right, so a centred column re-centres beside it: 220 to
 * the left from 1600 up, where the sidebar stays. From 1024 to 1599 the
 * sidebar yields instead, sliding out with the panel and back as it closes.
 * Both move with the panel's slide, and at once under reduced motion.
 */
export function ShellColumns({
  sidebar,
  children,
}: {
  /** The sidebar, when it sits beside the page. */
  sidebar: ReactNode;
  children: ReactNode;
}) {
  const room = usePreviewRoomOpen();
  const wide = useMediaQuery(WIDE);
  const sidebarShown = sidebar !== undefined && sidebar !== null;
  const yielded = sidebarShown && room && !wide;
  return (
    <>
      <div className="flex min-h-0 flex-1">
        {sidebarShown && (
          <div
            data-yielded={yielded ? '' : undefined}
            inert={yielded}
            className="flex shrink-0 transition-[margin] duration-300 ease-out data-yielded:-ml-64 motion-reduce:transition-none"
          >
            {sidebar}
          </div>
        )}
        <div
          data-preview-room={room ? '' : undefined}
          className="flex min-h-0 min-w-0 flex-1 flex-col transition-[padding] duration-300 ease-out data-preview-room:md:pr-[440px] motion-reduce:transition-none"
        >
          {children}
        </div>
      </div>
      {/* The Notice host shows every toast the console raises: bottom-left on a desktop, clear
        of a sheet's footer on the right, of the sidebar, and of an open preview panel, and on a
        phone at the top, under the top bar and clear of a bottom sheet's footer. */}
      <NoticeHost offsetPastSidebar={sidebarShown && !yielded} clearOfPanel={room} />
    </>
  );
}
