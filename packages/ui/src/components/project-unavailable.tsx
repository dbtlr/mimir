import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';

import { useUnarchiveProject } from '../api/mutations';
import { archivedProjectsQuery } from '../api/queries';
import type { WireNode } from '../api/types';
import { connectivity } from '../lib/connectivity';
import { calendarDate } from '../lib/time';
import { ProjectUnavailablePage } from '../routes/not-found';
import { RecordPending } from './record-layout';
import { ActionButton } from './ui/action-button';

/*
 * What a project address shows when the server answered 404 for it (ADR 0015).
 * An archived project is frozen, not gone: its page names it and offers
 * Unarchive, the one way back in. A key that names no project keeps the plain
 * unavailable notice.
 */

/** An archived project's page: its name, when it was archived, and Unarchive. */
function ArchivedProjectPage({ project, offline }: { project: WireNode; offline: boolean }) {
  const navigate = useNavigate();
  const unarchive = useUnarchiveProject(project.id);
  const archivedOn = project.archived_at == null ? undefined : calendarDate(project.archived_at);
  return (
    <main className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col items-start gap-3 p-5">
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
        <h1 className="text-header font-bold tracking-[-0.01em] text-ink-bright">
          {project.title}
        </h1>
        <span className="rounded-[5px] px-[7px] py-[3px] font-mono text-tag text-ink-faint inset-ring inset-ring-line-bright">
          {project.id}
        </span>
        <span className="font-mono text-tag text-ink-faint">
          Archived{archivedOn !== undefined && ` · ❄ ${archivedOn}`}
        </span>
      </div>
      <p className="text-xs leading-relaxed text-ink-dim">
        This project is frozen. It is hidden from the board and every default view, and nothing is
        deleted. Unarchive it to work in it again.
      </p>
      <div className="flex items-center gap-4">
        <ActionButton
          aria-label={`Unarchive ${project.title}`}
          disabled={offline || unarchive.isPending}
          onClick={() => {
            unarchive.mutate(undefined, {
              onSuccess: () => {
                void navigate({ params: { key: project.id }, to: '/p/$key' });
              },
            });
          }}
        >
          Unarchive
        </ActionButton>
        <Link
          to="/"
          className="text-xs font-semibold text-accent-foreground transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
        >
          ← Back to the review page
        </Link>
      </div>
    </main>
  );
}

/**
 * The page for a project key the server 404ed: the archived project's page
 * when the archived list names it, else the plain unavailable notice. The list
 * is read first, so an archived project never flashes the unavailable notice.
 */
export function UnavailableProject({ projectKey }: { projectKey: string }) {
  const archived = useQuery(archivedProjectsQuery);
  const { offline } = connectivity([archived]);
  const match = archived.data?.items.find((p) => p.id === projectKey);
  if (match !== undefined) {
    return <ArchivedProjectPage project={match} offline={offline} />;
  }
  if (archived.isPending) {
    return <RecordPending unreachable={false} />;
  }
  return <ProjectUnavailablePage projectKey={projectKey} />;
}
