import { Link } from '@tanstack/react-router';

/** Any path the console has no page for. */
export function NotFoundPage() {
  return (
    <main className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col items-start gap-3 p-5">
      <h1 className="text-header font-bold tracking-[-0.01em] text-ink-bright">Not found</h1>
      <p className="text-xs leading-relaxed text-ink-dim">
        The console has no page at this address.
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
