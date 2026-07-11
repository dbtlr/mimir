import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { Toaster } from 'sonner';

import { AttentionAlert } from '../components/attention-alert';
import { ProjectPicker } from '../components/project-picker';
import { ThemeToggle } from '../components/theme-toggle';
import { MenuContent, MenuItem, MenuRoot, MenuTrigger } from '../components/ui/menu';
import { VersionFooter } from '../components/version-footer';
import { useTheme } from '../lib/use-theme';
import { useToastPosition } from '../lib/use-toast-position';

/** The app shell: brand + project picker, the routed surface, and the global
 * top-bar controls (artifacts, attention, theme). */
export function Shell() {
  const { theme, toggle } = useTheme();
  const toastPosition = useToastPosition();
  const navigate = useNavigate();
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="z-20 flex items-center gap-2 border-b border-line bg-well-900/85 px-4 py-2 backdrop-blur">
        <Link
          to="/"
          className="rounded font-mono text-card-mobile font-bold tracking-tight text-ink-bright focus-visible:outline-2 focus-visible:outline-accent"
        >
          Mimir
        </Link>
        <ProjectPicker />
        <div className="ml-auto flex items-center gap-1">
          {/* desktop — the secondary nav inline */}
          <Link
            to="/tasks"
            className="microlabel hidden rounded px-2 py-1 text-ink-dim transition-colors hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent md:inline-block"
          >
            Tasks
          </Link>
          <Link
            to="/artifacts"
            className="microlabel hidden rounded px-2 py-1 text-ink-dim transition-colors hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent md:inline-block"
          >
            Artifacts
          </Link>
          <AttentionAlert />
          <ThemeToggle theme={theme} onToggle={toggle} />
          {/* mobile — the secondary nav folds into an overflow menu */}
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
              <MenuItem className="py-2.5 text-sm" onClick={() => void navigate({ to: '/tasks' })}>
                Tasks
              </MenuItem>
              <MenuItem
                className="py-2.5 text-sm"
                onClick={() => void navigate({ to: '/artifacts' })}
              >
                Artifacts
              </MenuItem>
            </MenuContent>
          </MenuRoot>
        </div>
      </header>
      <Outlet />
      <VersionFooter />
      {/* Desktop: bottom-LEFT — the sheet/dossier rail owns the bottom-right
          corner, and a toast there sits on top of (and intercepts clicks meant
          for) the rail's footer actions — exactly the error-retry path toasts
          announce. Mobile: top-center — sonner goes full-width at the bottom
          below 600px no matter the x-position, right over the bottom sheet's
          footer, so small viewports route toasts to the top instead. */}
      <Toaster theme={theme} position={toastPosition} richColors closeButton />
    </div>
  );
}
