import { Link, Outlet } from "@tanstack/react-router";

/** The app shell: brand bar + the routed surface. */
export function Shell() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="z-20 flex items-center gap-3 border-b border-line bg-well-900/85 px-4 py-2 backdrop-blur">
        <Link
          to="/"
          className="flex items-baseline gap-2 focus-visible:outline-2 focus-visible:outline-accent"
        >
          <span className="font-mono text-[15px] font-bold tracking-[0.22em] text-ink-bright">
            MIMIR
          </span>
          <span className="microlabel hidden text-ink-faint sm:inline">operator console</span>
        </Link>
      </header>
      <Outlet />
    </div>
  );
}
