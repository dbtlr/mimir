import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { Toaster } from 'sonner';

import { AttentionAlert } from '../components/attention-alert';
import { BrandMark } from '../components/brand-mark';
import { JumpPalette } from '../components/jump-palette';
import { ProjectDrawer, ProjectSidebar } from '../components/project-sidebar';
import { PwaUpdateBanner } from '../components/pwa-update-banner';
import { PwaUpdateProvider } from '../components/pwa-update-provider';
import { SeedCaptureProvider } from '../components/seed-capture';
import { TopBarMore } from '../components/top-bar-more';
import { VersionFooter } from '../components/version-footer';
import { useCurrentProjectKey, useRememberCurrentProject } from '../lib/current-project';
import { isSettingsPath, sidebarContextOf } from '../lib/project-sidebar';
import { useMediaQuery } from '../lib/use-media-query';
import { useTheme } from '../lib/use-theme';
import { useToastPosition } from '../lib/use-toast-position';
import { useOpenerFocus } from '../lib/walkthrough-mark';

/**
 * Tailwind's `lg`: from here up the project sidebar sits beside the page; below
 * it, a drawer. Between `md` and `lg` a record page's own 300px rail would
 * leave the content about 160px beside a 256px sidebar.
 */
const DESKTOP = '(min-width: 1024px)';

/** The sidebar's width plus a gutter, so a desktop toast clears it. */
const TOAST_OFFSET_PAST_SIDEBAR = { left: 'calc(16rem + 24px)' };

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
        const main = document.querySelector('main');
        if (main !== null) {
          // Pages mark their main focusable; one that does not still takes focus.
          if (!main.hasAttribute('tabindex')) {
            main.tabIndex = -1;
          }
          main.focus();
        }
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
      <ShellContent />
    </PwaUpdateProvider>
  );
}

function ShellContent() {
  const { theme, toggle } = useTheme();
  useOpenerFocus();
  const toastPosition = useToastPosition();
  const desktop = useMediaQuery(DESKTOP);
  useRememberCurrentProject();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // With no project there is nothing to frame: the review page at / handles
  // creating the first one. The remembered project only decides that a project
  // exists; the sidebar's context comes from the page (MMR-505).
  const framed = useCurrentProjectKey() !== undefined;
  // Settings is framed with no project too: pairing a device comes first.
  const context = framed || isSettingsPath(pathname) ? sidebarContextOf(pathname) : undefined;
  const sidebarShown = context !== undefined && desktop;
  return (
    <SeedCaptureProvider>
      <div className="flex h-dvh flex-col overflow-hidden">
        <SkipLink />
        {/* Solid well-950, the top bar's own ground, which the browser chrome
          also takes (theme-color): a translucent bar here let the status bar
          fade into it. The safe-area pad keeps the bar's ground under a status
          bar that overlays the page. */}
        <header className="z-20 flex items-center gap-2 border-b border-line bg-well-950 px-4 pt-[calc(0.5rem+env(safe-area-inset-top))] pb-2 max-lg:px-2 max-md:gap-1">
          {context !== undefined && !desktop && <ProjectDrawer context={context} />}
          <Link
            to="/"
            className="flex items-center gap-2 rounded font-mono text-card-mobile font-bold max-md:ml-1 tracking-tight text-ink-bright focus-visible:outline-2 focus-visible:outline-accent"
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
        <div className="flex min-h-0 flex-1">
          {sidebarShown && <ProjectSidebar context={context} />}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <PwaUpdateBanner />
            <Outlet />
            <VersionFooter />
          </div>
        </div>
        {/* Desktop: bottom-LEFT — a sheet's rail owns the bottom-right
          corner, and a toast there sits on top of (and intercepts clicks meant
          for) the rail's footer actions — exactly the error-retry path toasts
          announce. Mobile: top-center — sonner goes full-width at the bottom
          below 600px no matter the x-position, right over the bottom sheet's
          footer, so small viewports route toasts to the top instead. */}
        <Toaster
          theme={theme}
          position={toastPosition}
          offset={sidebarShown ? TOAST_OFFSET_PAST_SIDEBAR : undefined}
          richColors
          closeButton
        />
      </div>
    </SeedCaptureProvider>
  );
}
