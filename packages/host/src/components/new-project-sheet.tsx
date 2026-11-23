import { useCreateProject } from '../api/shell-mutations';
import { useOpeningKey } from './patterns/opening';
import { ProjectForm } from './project-form';

/**
 * The create-project form (21a / MMR-230), shared by every "+ New project"
 * trigger (Home's first-project prompt and the project picker): the
 * project form in the Form sheet (MMR-743). A server refusal toasts verbatim
 * (via the mutation) and the form stays open with its values.
 */
export function NewProjectSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateProject();
  const opening = useOpeningKey(open);
  return (
    <ProjectForm
      key={opening}
      mode="create"
      open={open}
      onClose={() => {
        onOpenChange(false);
      }}
      onCreate={(values) => create.mutateAsync(values)}
    />
  );
}
