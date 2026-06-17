import { Link, Outlet } from "@tanstack/react-router";
import { Toaster } from "sonner";
import { ThemeToggle } from "../components/theme-toggle";
import { useTheme } from "../lib/use-theme";

/** The app shell: brand bar + the routed surface. */
export function Shell() {
  const { theme, toggle } = useTheme();
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="z-20 flex items-center gap-3 border-b border-line bg-well-900/85 px-4 py-2 backdrop-blur">
        <Link
          to="/"
          className="flex items-baseline gap-2 focus-visible:outline-2 focus-visible:outline-accent"
        >
          <span className="font-mono text-[0.9375rem] font-bold tracking-[0.22em] text-ink-bright">
            MIMIR
          </span>
          <span className="microlabel hidden text-ink-faint sm:inline">operator console</span>
        </Link>
        <Link
          to="/artifacts"
          className="microlabel text-ink-dim transition-colors hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent"
        >
          Artifacts
        </Link>
        <div className="ml-auto">
          <ThemeToggle theme={theme} onToggle={toggle} />
        </div>
      </header>
      <Outlet />
      <Toaster theme={theme} position="bottom-right" richColors closeButton />
    </div>
  );
}
