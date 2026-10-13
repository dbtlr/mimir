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

/** Tailwind's `md`: from here up the project sidebar sits beside the page; below it, a drawer. */
const DESKTOP = '(min-width: 768px)';

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
  return (
    <SeedCaptureProvider>
      <div className="flex h-dvh flex-col overflow-hidden">
        <header className="z-20 flex items-center gap-2 border-b border-line bg-well-900/85 px-4 py-2 backdrop-blur max-md:px-2">
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
          {projectKey !== undefined && desktop && <ProjectSidebar projectKey={projectKey} />}
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
        <Toaster theme={theme} position={toastPosition} richColors closeButton />
      </div>
    </SeedCaptureProvider>
  );
}
