import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { useArchiveProject, useUnarchiveProject, useUpdateProject } from '../api/shell-mutations';
import { archivedUndoToast } from './archive-undo-toast';
import { useOpeningKey } from './patterns/opening';
import { ProjectForm } from './project-form';
import type { EditedProject } from './project-form';

export type { ProjectFormValues } from './project-form';

/**
 * Modest settings affordance on the project's work page head. Opens the
 * project form (MMR-743) to rename the project, edit its description, and, in
 * its Lifecycle group (20b / MMR-230), archive it. Archiving carries no
 * confirm: the Notice's Undo is the safety (ADR 0015), and since the archived
 * project 404s, the form closes and navigation returns to the review page.
 */
export function ProjectSettingsButton({
  project,
  offline,
}: {
  project: EditedProject;
  offline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const opening = useOpeningKey(open);
  const navigate = useNavigate();
  const update = useUpdateProject(project.id);
  const archive = useArchiveProject(project.id);
  const unarchive = useUnarchiveProject(project.id);

  const handleArchive = () => {
    archive.mutate(undefined, {
      onSuccess: () => {
        setOpen(false);
        // Shared MMR-125 undo Notice, held for 10s (longer than the 5s
        // default): with no confirm, this Notice may still be the nearest
        // unarchive affordance at the moment of archive — give the operator a
        // real window to catch it. The archived project's page is the durable path.
        archivedUndoToast(project.title, () => unarchive.mutate(undefined), { duration: 10_000 });
        void navigate({ to: '/' });
      },
    });
  };

  return (
    <>
      <button
        type="button"
        aria-label="Project settings"
        aria-haspopup="dialog"
        disabled={offline === true}
        onClick={() => setOpen(true)}
        className="rounded border border-line bg-well-850 px-2 py-1.5 text-xs font-medium text-ink-dim transition-colors hover:bg-well-800 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40"
      >
        ⚙
      </button>
      <ProjectForm
        key={opening}
        mode="edit"
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        project={project}
        onSave={(values) => update.mutateAsync(values)}
        onArchive={handleArchive}
        archiving={archive.isPending}
        offline={offline === true}
      />
    </>
  );
}
