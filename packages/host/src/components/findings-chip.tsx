import { Link } from '@tanstack/react-router';

import { findingCount } from '../lib/health';

/**
 * A project's record-health findings (MMR-185) as an amber chip linking to
 * the doctor panel scoped to that project. Renders nothing at zero.
 */
export function FindingsChip({ projectKey, findings }: { projectKey: string; findings: number }) {
  if (findings <= 0) {
    return null;
  }
  return (
    <Link
      to="/doctor"
      search={{ project: projectKey }}
      className="inline-flex items-center gap-1.5 rounded-full bg-status-in-progress/10 px-2.5 py-1 text-tag font-semibold text-status-in-progress-foreground inset-ring inset-ring-status-in-progress/30 transition-colors hover:bg-status-in-progress/16 focus-visible:outline-2 focus-visible:outline-accent"
    >
      <span aria-hidden className="size-1.5 rounded-full bg-status-in-progress" />
      {findingCount(findings)}
    </Link>
  );
}
