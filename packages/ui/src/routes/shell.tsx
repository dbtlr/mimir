import { Link, Outlet } from '@tanstack/react-router';
import { Toaster } from 'sonner';

import { AttentionAlert } from '../components/attention-alert';
import { BrandMark } from '../components/brand-mark';
import { JumpPalette } from '../components/jump-palette';
import { ProjectDrawer, ProjectSidebar } from '../components/project-sidebar';
import { PwaRefreshAction } from '../components/pwa-refresh-action';
import { PwaUpdateBanner } from '../components/pwa-update-banner';
import { PwaUpdateProvider } from '../components/pwa-update-provider';
import { SeedCaptureProvider } from '../components/seed-capture';
import { ThemeToggle } from '../components/theme-toggle';
import { VersionFooter } from '../components/version-footer';
import { useCurrentProjectKey, useRememberCurrentProject } from '../lib/current-project';
import { useMediaQuery } from '../lib/use-media-query';
import { useTheme } from '../lib/use-theme';
import { useToastPosition } from '../lib/use-toast-position';

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
 * palette, Needs you, theme toggle), the current project's sidebar, and the
 * routed surface.
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
  const toastPosition = useToastPosition();
  const desktop = useMediaQuery(DESKTOP);
  useRememberCurrentProject();
  // With no project there is nothing to frame: the review page at / handles
  // creating the first one.
  const projectKey = useCurrentProjectKey();
  const sidebarShown = projectKey !== undefined && desktop;
  return (
    <SeedCaptureProvider>
      <div className="flex h-dvh flex-col overflow-hidden">
        <SkipLink />
        <header className="z-20 flex items-center gap-2 border-b border-line bg-well-900/85 px-4 py-2 backdrop-blur max-lg:px-2">
          {projectKey !== undefined && !desktop && <ProjectDrawer projectKey={projectKey} />}
          <Link
            to="/"
            className="flex items-center gap-2 rounded font-mono text-card-mobile font-bold tracking-tight text-ink-bright focus-visible:outline-2 focus-visible:outline-accent"
          >
            <BrandMark />
            Mimir
          </Link>
          <div className="ml-auto flex items-center gap-1">
            <JumpPalette />
            <AttentionAlert />
            <PwaRefreshAction />
            <ThemeToggle theme={theme} onToggle={toggle} />
          </div>
        </header>
        <div className="flex min-h-0 flex-1">
          {sidebarShown && <ProjectSidebar projectKey={projectKey} />}
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
