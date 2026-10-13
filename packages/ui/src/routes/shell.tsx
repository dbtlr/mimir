import { Link, Outlet, useMatchRoute, useNavigate } from '@tanstack/react-router';
import { Toaster } from 'sonner';

import { AttentionAlert } from '../components/attention-alert';
import { BrandMark } from '../components/brand-mark';
import { JumpPalette } from '../components/jump-palette';
import { ProjectPicker } from '../components/project-picker';
import { PwaRefreshAction } from '../components/pwa-refresh-action';
import { PwaUpdateBanner } from '../components/pwa-update-banner';
import { PwaUpdateProvider } from '../components/pwa-update-provider';
import { SeedCaptureProvider } from '../components/seed-capture';
import { ThemeToggle } from '../components/theme-toggle';
import { MenuContent, MenuItem, MenuRoot, MenuTrigger } from '../components/ui/menu';
import { VersionFooter } from '../components/version-footer';
import { cn } from '../lib/cn';
import { useCurrentProjectKey, useRememberCurrentProject } from '../lib/current-project';
import { useTheme } from '../lib/use-theme';
import { useToastPosition } from '../lib/use-toast-position';

/**
 * The top-bar sections, in order — one list feeds the inline nav and the
 * overflow menu. Each is a browser of the current project (MMR-495).
 */
const NAV_SECTIONS = [
  { label: 'Tasks', to: '/p/$key/tasks' },
  { label: 'Artifacts', to: '/p/$key/artifacts' },
  { label: 'Seeds', to: '/p/$key/seeds' },
] as const;

/**
 * The active section's selection treatment (ADR 0019): the accent as a
 * low-alpha wash with a hairline inset ring, never a solid fill. Keyed on
 * `aria-current`, which the router sets and the menu items set by hand.
 */
const ACTIVE_NAV =
  'aria-[current=page]:bg-accent/10 aria-[current=page]:text-ink-bright aria-[current=page]:inset-ring aria-[current=page]:inset-ring-accent/28';

/** The app shell: brand + project picker, the routed surface, and the global
 * top-bar controls (jump palette, artifacts, attention, theme). */
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
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();
  useRememberCurrentProject();
  // With no project to browse there are no sections to offer.
  const projectKey = useCurrentProjectKey();
  const sections =
    projectKey === undefined
      ? []
      : NAV_SECTIONS.map(({ label, to }) => ({ label, params: { key: projectKey }, to }));
  return (
    <SeedCaptureProvider>
      <div className="flex h-dvh flex-col overflow-hidden">
        <header className="z-20 flex items-center gap-2 border-b border-line bg-well-900/85 px-4 py-2 backdrop-blur">
          <Link
            to="/"
            className="flex items-center gap-2 rounded font-mono text-card-mobile font-bold tracking-tight text-ink-bright focus-visible:outline-2 focus-visible:outline-accent"
          >
            <BrandMark />
            Mimir
          </Link>
          <ProjectPicker />
          <div className="ml-auto flex items-center gap-1">
            <JumpPalette />
            {/* desktop — the secondary nav inline */}
            {sections.map(({ label, params, to }) => (
              <Link
                key={to}
                to={to}
                params={params}
                // Search params (filters) never un-mark the section.
                activeOptions={{ includeSearch: false }}
                className={cn(
                  'microlabel hidden rounded px-2 py-1 text-ink-dim transition-colors hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent md:inline-block',
                  ACTIVE_NAV,
                )}
              >
                {label}
              </Link>
            ))}
            <AttentionAlert />
            <PwaRefreshAction />
            <ThemeToggle theme={theme} onToggle={toggle} />
            {/* mobile — the secondary nav folds into an overflow menu */}
            {sections.length > 0 && (
              <MenuRoot>
                <MenuTrigger
                  aria-label="More"
                  className="flex h-9 w-9 items-center justify-center rounded text-ink-dim transition-colors hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent md:hidden"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <circle cx="5" cy="12" r="1.6" />
                    <circle cx="12" cy="12" r="1.6" />
                    <circle cx="19" cy="12" r="1.6" />
                  </svg>
                </MenuTrigger>
                <MenuContent className="w-44">
                  {sections.map(({ label, params, to }) => (
                    <MenuItem
                      key={to}
                      className={cn('py-2.5 text-sm', ACTIVE_NAV)}
                      aria-current={
                        matchRoute({ fuzzy: true, includeSearch: false, params, to })
                          ? 'page'
                          : undefined
                      }
                      onClick={() => void navigate({ params, to })}
                    >
                      {label}
                    </MenuItem>
                  ))}
                </MenuContent>
              </MenuRoot>
            )}
          </div>
        </header>
        <PwaUpdateBanner />
        <Outlet />
        <VersionFooter />
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
