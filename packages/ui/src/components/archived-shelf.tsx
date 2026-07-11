import { useState } from 'react';

import { useUnarchiveProject } from '../api/mutations';
import type { WireNode } from '../api/types';
import { ActionButton } from './ui/action-button';

/**
 * The Archived shelf on the Overview (MMR-125, mock 20a): a separate section
 * below the At-rest lane — folded to a recessed count row by default, unfolding
 * (`aria-expanded`) to a grid of dashed-border frozen cards. Frozen cards are
 * display + Unarchive only: archived projects 404 on get/tree (ADR 0015), so
 * the card is deliberately not a link — the only way back in is Unarchive, with
 * no confirmation (unarchive is the undo). Absent entirely at zero archived
 * projects — the shelf never shows an empty state.
 */

/** Leaf-task total for the count line — the sum of the per-status leaf tally
 * (no `task_count` on the wire; the leaf distribution is the derivable source). */
function taskCountOf(project: WireNode): number {
  return Object.values(project.leaf_counts ?? {}).reduce((sum, n) => sum + n, 0);
}

function countLine(project: WireNode): string {
  const tasks = taskCountOf(project);
  const parts = [`${String(tasks)} ${tasks === 1 ? 'task' : 'tasks'}`];
  const artifacts = project.artifact_count;
  if (artifacts !== undefined) {
    parts.push(`${String(artifacts)} ${artifacts === 1 ? 'artifact' : 'artifacts'}`);
  }
  parts.push('readable, nothing writable');
  return parts.join(' · ');
}

function FrozenProjectCard({ project, offline }: { project: WireNode; offline: boolean }) {
  const unarchive = useUnarchiveProject(project.id);
  // `❄ YYYY-MM-DD` — the frozen date, omitted rather than broken when absent.
  const frozenAt = project.archived_at?.slice(0, 10);

  return (
    <div className="flex flex-col gap-2.5 rounded-[11px] border border-dashed border-line bg-well-recessed px-[15px] py-[13px]">
      <div className="flex items-center gap-2">
        <span className="shrink-0 font-mono text-mono-id text-ink-ghost">{project.id}</span>
        <span className="truncate text-body font-semibold text-ink-dim">{project.title}</span>
        {frozenAt !== undefined && (
          <span className="ml-auto shrink-0 font-mono text-micro text-ink-ghost">❄ {frozenAt}</span>
        )}
      </div>
      <p className="text-tag text-ink-faint">{countLine(project)}</p>
      <ActionButton
        variant="outline"
        aria-label={`Unarchive ${project.title}`}
        className="self-start rounded-[7px] px-[13px] py-[5px] text-mono-id text-ink-dim max-sm:min-h-11"
        disabled={offline || unarchive.isPending}
        onClick={() => {
          unarchive.mutate();
        }}
      >
        Unarchive
      </ActionButton>
    </div>
  );
}

export function ArchivedShelf({ projects, offline }: { projects: WireNode[]; offline: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (projects.length === 0) {
    return null;
  }

  return (
    <section
      aria-label="Archived projects"
      className="overflow-hidden rounded-xl border border-line"
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`Archived, ${String(projects.length)} ${projects.length === 1 ? 'project' : 'projects'}`}
        onClick={() => {
          setExpanded((e) => !e);
        }}
        className="flex w-full items-center gap-2.5 bg-well-950 px-4 py-[11px] text-left focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span className="shrink-0 font-mono text-micro font-semibold tracking-[0.13em] text-ink-ghost uppercase">
          Archived · {projects.length}
        </span>
        <span className="truncate text-tag text-ink-ghost">
          frozen — hidden from every default view, picker included
        </span>
        <span aria-hidden="true" className="ml-auto shrink-0 text-micro text-ink-ghost">
          {expanded ? '⌃' : '⌄'}
        </span>
      </button>
      {expanded && (
        <div className="grid gap-2.5 bg-well-950 px-4 pt-0.5 pb-3 sm:grid-cols-2">
          {projects.map((project) => (
            <FrozenProjectCard key={project.id} project={project} offline={offline} />
          ))}
        </div>
      )}
    </section>
  );
}
