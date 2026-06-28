import type { WireNode } from '../api/types';
import { cn } from '../lib/cn';
import { STATUS_META } from '../lib/status';
import { CardVitals } from './card-vitals';
import { StatusBadge } from './status-badge';
import { Card, CardContent, CardHeader } from './ui/card';

/**
 * One project on the overview (MMR-106): key, title, status, an optional going-cold
 * temperature pill, and the **vitals panel** — the five actionable-state leaf
 * counts (review · in prog · ready · await · blocked) from the leaf-counts facet
 * (MMR-105). Replaces the old single ready hero + full distribution bar.
 */
export function ProjectCard({
  project,
  onOpen,
}: {
  project: WireNode;
  onOpen: (key: string) => void;
}) {
  return (
    <Card
      className={cn(
        'border-l-2 transition-colors hover:border-line-bright',
        STATUS_META[project.status].border,
      )}
    >
      <button
        type="button"
        onClick={() => {
          onOpen(project.id);
        }}
        className="block w-full text-left focus-visible:outline-2 focus-visible:outline-accent"
      >
        <CardHeader className="flex-row items-start justify-between">
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex items-baseline gap-2.5">
              <span className="font-mono text-base font-bold tracking-tight text-ink-bright">
                {project.id}
              </span>
              <span className="truncate text-sm text-ink">{project.title}</span>
            </div>
            {project.description != null && project.description !== '' && (
              <p className="truncate text-2xs text-ink-dim">{project.description}</p>
            )}
            {project.attention?.stale === true && (
              <span className="mt-1 inline-flex items-center gap-1 self-start rounded-sm bg-cold/15 px-1.5 py-0.5 text-3xs font-semibold tracking-wider text-cold uppercase">
                <svg
                  viewBox="0 0 16 16"
                  className="h-2.5 w-2.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <circle cx="8" cy="8" r="6" />
                  <path d="M8 5v3l2 1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                going cold
              </span>
            )}
          </div>
          <StatusBadge status={project.status} />
        </CardHeader>
        {project.leaf_counts !== undefined && (
          <CardContent>
            <CardVitals counts={project.leaf_counts} />
          </CardContent>
        )}
      </button>
    </Card>
  );
}
