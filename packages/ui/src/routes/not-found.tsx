import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

/**
 * A page with nothing to show: any path the console has no page for, or a
 * record address that names no record. `projectKey` points the way back at
 * the record's project instead of the Overview.
 */
export function NotFoundPage({
  children = 'The console has no page at this address.',
  projectKey,
}: {
  children?: ReactNode;
  projectKey?: string;
}) {
  const back =
    'text-xs font-semibold text-accent-foreground transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-accent';
  return (
    <main className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col items-start gap-3 p-5">
      <h1 className="text-header font-bold tracking-[-0.01em] text-ink-bright">Not found</h1>
      <p className="text-xs leading-relaxed text-ink-dim">{children}</p>
      {projectKey === undefined ? (
        <Link to="/" className={back}>
          ← Back to Overview
        </Link>
      ) : (
        <Link to="/p/$key" params={{ key: projectKey }} className={back}>
          ← Back to {projectKey}
        </Link>
      )}
    </main>
  );
}

/**
 * A project address the server answered 404 for: archived or gone (ADR 0015).
 * Not "offline" — the server answered — so it gets a notice and a way home
 * instead of a sticky false Offline banner.
 */
export function ProjectUnavailablePage({ projectKey }: { projectKey: string }) {
  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col items-start gap-3 p-5">
      <div className="flex items-center gap-3.5">
        <h1 className="text-header font-bold tracking-[-0.01em] text-ink-bright">
          Project unavailable
        </h1>
        <span className="rounded-[5px] px-[7px] py-[3px] font-mono text-tag text-ink-faint inset-ring inset-ring-line-bright">
          {projectKey}
        </span>
      </div>
      <p className="text-xs leading-relaxed text-ink-dim">
        This project is archived or no longer exists. Archived projects leave the board and picker;
        nothing is deleted.
      </p>
      <Link
        to="/"
        className="text-xs font-semibold text-accent-foreground transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
      >
        ← Back to Overview
      </Link>
    </main>
  );
}
