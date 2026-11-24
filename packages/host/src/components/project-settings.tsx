import { useNavigate } from '@tanstack/react-router';

import { useArchiveProject, useUnarchiveProject, useUpdateProject } from '../api/shell-mutations';
import { archivedUndoToast } from './archive-undo-toast';
import { useOpeningKey } from './patterns/opening';
import { ProjectForm } from './project-form';
import type { EditedProject } from './project-form';

export type { ProjectFormValues } from './project-form';

/**
 * A project's settings, opened from Edit in its header's More (MMR-726): the
 * project form (MMR-743) to rename the project, edit its description, and, in
 * its Lifecycle group (20b / MMR-230), archive it. Archiving carries no
 * confirm: the Notice's Undo is the safety (ADR 0015), and since the archived
 * project 404s, the form closes and navigation returns to Home.
 */
export function ProjectSettings({
  project,
  offline,
  open,
  onClose,
}: {
  project: EditedProject;
  offline?: boolean;
  open: boolean;
  onClose: () => void;
}) {
  const opening = useOpeningKey(open);
  const navigate = useNavigate();
  const update = useUpdateProject(project.id);
  const archive = useArchiveProject(project.id);
  const unarchive = useUnarchiveProject(project.id);

  const handleArchive = () =>
    archive.mutateAsync(undefined, {
      onSuccess: () => {
        onClose();
        // Shared MMR-125 undo Notice, held for 10s (longer than the 5s
        // default): with no confirm, this Notice may still be the nearest
        // unarchive affordance at the moment of archive — give the operator a
        // real window to catch it. The archived project's page is the durable path.
        archivedUndoToast(project.title, () => unarchive.mutate(undefined), { duration: 10_000 });
        void navigate({ to: '/' });
      },
    });

  return (
    <ProjectForm
      key={`${project.id}:${String(opening)}`}
      mode="edit"
      open={open}
      onClose={onClose}
      project={project}
      onSave={(values) => update.mutateAsync(values)}
      onArchive={handleArchive}
      archiving={archive.isPending}
      offline={offline === true}
    />
  );
}
