import { Link, Outlet } from "@tanstack/react-router";
import { Toaster } from "sonner";
import { AttentionAlert } from "../components/attention-alert";
import { ProjectPicker } from "../components/project-picker";
import { ThemeToggle } from "../components/theme-toggle";
import { useTheme } from "../lib/use-theme";

/** The app shell: brand + project picker, the routed surface, and the global
 * top-bar controls (artifacts, attention, theme). */
export function Shell() {
  const { theme, toggle } = useTheme();
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="z-20 flex items-center gap-2 border-b border-line bg-well-900/85 px-4 py-2 backdrop-blur">
        <Link
          to="/"
          className="rounded font-mono text-[0.9375rem] font-bold tracking-tight text-ink-bright focus-visible:outline-2 focus-visible:outline-accent"
        >
          Mimir
        </Link>
        <ProjectPicker />
        <div className="ml-auto flex items-center gap-1">
          <Link
            to="/artifacts"
            className="microlabel rounded px-2 py-1 text-ink-dim transition-colors hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent"
          >
            Artifacts
          </Link>
          <AttentionAlert />
          <ThemeToggle theme={theme} onToggle={toggle} />
        </div>
      </header>
      <Outlet />
      <Toaster theme={theme} position="bottom-right" richColors closeButton />
    </div>
  );
}
