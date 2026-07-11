import { useForm } from '@tanstack/react-form';
import { useNavigate } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { toast } from 'sonner';

import { useArchiveProject, useUnarchiveProject, useUpdateProject } from '../api/mutations';
import type { WireNode } from '../api/types';
import { ActionButton } from './ui/action-button';
import { Sheet, SheetContent, SheetTitle } from './ui/sheet';

export type ProjectFormValues = {
  title: string;
  description: string;
};

/**
 * Modest settings affordance for the active project board header. Opens a
 * Sheet letting the user rename the project, edit its description, and — in
 * the LIFECYCLE section (20b / MMR-230) — archive it. Archiving carries no
 * confirm: the undo toast's Unarchive is the safety (ADR 0015), and since the
 * archived project 404s, the sheet closes and navigation returns to the
 * Overview.
 */
export function ProjectSettingsButton({
  project,
  offline,
}: {
  project: WireNode;
  offline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const lifecycleCopyId = useId();
  const navigate = useNavigate();
  const update = useUpdateProject(project.id);
  const archive = useArchiveProject(project.id);
  const unarchive = useUnarchiveProject(project.id);

  const handleArchive = () => {
    archive.mutate(undefined, {
      onSuccess: () => {
        setOpen(false);
        toast(`Archived ${project.title}`, {
          action: { label: 'Unarchive', onClick: () => unarchive.mutate(undefined) },
        });
        void navigate({ to: '/' });
      },
    });
  };

  return (
    <>
      <button
        type="button"
        aria-label="Project settings"
        disabled={offline === true}
        onClick={() => setOpen(true)}
        className="rounded border border-line bg-well-850 px-2 py-1.5 text-xs font-medium text-ink-dim transition-colors hover:bg-well-800 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40"
      >
        ⚙
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        {open && (
          <SheetContent aria-describedby={undefined}>
            <div className="flex flex-col gap-4 p-4">
              <div className="flex items-center gap-2">
                <SheetTitle className="microlabel text-ink-faint">Project settings</SheetTitle>
                <span className="rounded-[5px] px-[7px] py-[3px] font-mono text-tag text-ink-faint inset-ring inset-ring-line-bright">
                  {project.id}
                </span>
              </div>
              <ProjectSettingsForm
                project={project}
                submitting={update.isPending}
                onSubmit={(values) => {
                  update.mutate(values, { onSuccess: () => setOpen(false) });
                }}
                onCancel={() => setOpen(false)}
              />
              {/* LIFECYCLE (20b): archive is slate, not red — nothing is
                  destroyed — and deliberately not adjacent to Save (the form
                  footer's DOM order keeps Cancel between Save and this button
                  in the tab sequence). The contract copy doubles as the
                  button's accessible description, so a screen reader hears
                  the no-confirm consequences before activating it. */}
              <section className="flex flex-col gap-2.5 border-t border-line pt-3.5">
                <h3 className="microlabel text-ink-faint">Lifecycle</h3>
                <p id={lifecycleCopyId} className="text-[12.5px] leading-[1.65] text-ink-dim">
                  Archiving freezes the project and hides it everywhere by default — board, picker,
                  tasks, attention. Everything stays readable from the Archived shelf. Reversible
                  any time; nothing is deleted.
                </p>
                <button
                  type="button"
                  aria-describedby={lifecycleCopyId}
                  disabled={offline === true || archive.isPending}
                  onClick={handleArchive}
                  className="self-start rounded-lg bg-[#31485e] px-[15px] py-[7px] text-xs font-semibold text-white transition-colors hover:bg-[#31485e]/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Archive project
                </button>
              </section>
            </div>
          </SheetContent>
        )}
      </Sheet>
    </>
  );
}

function ProjectSettingsForm({
  project,
  submitting,
  onSubmit,
  onCancel,
}: {
  project: WireNode;
  submitting?: boolean;
  onSubmit: (values: ProjectFormValues) => void;
  onCancel: () => void;
}) {
  const form = useForm({
    defaultValues: {
      description: project.description ?? '',
      title: project.title,
    } satisfies ProjectFormValues,
    onSubmit: ({ value }) => {
      const title = value.title.trim();
      if (title === '') {
        return;
      }
      onSubmit({
        description: value.description.trim(),
        title,
      });
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
      className="flex flex-col gap-3"
    >
      {/* Name */}
      <div className="flex flex-col gap-1">
        <label htmlFor="project-form-title" className="text-xs font-medium text-ink-dim">
          Name
        </label>
        <form.Field name="title">
          {(field) => (
            <input
              id="project-form-title"
              type="text"
              name={field.name}
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              onBlur={field.handleBlur}
              placeholder="Project name"
              className="rounded border border-line bg-well-850 px-2 py-1.5 text-xs text-ink outline-none focus-visible:border-accent"
            />
          )}
        </form.Field>
      </div>

      {/* Description */}
      <div className="flex flex-col gap-1">
        <label htmlFor="project-form-description" className="text-xs font-medium text-ink-dim">
          Description
        </label>
        <form.Field name="description">
          {(field) => (
            <textarea
              id="project-form-description"
              name={field.name}
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              onBlur={field.handleBlur}
              placeholder="Optional description"
              className="min-h-20 resize-y rounded border border-line bg-well-850 p-2 text-xs text-ink outline-none focus-visible:border-accent"
            />
          )}
        </form.Field>
      </div>

      {/* Buttons — DOM order Save→Cancel under row-reverse keeps the visual
          Cancel|Save while putting Cancel between Save and the no-confirm
          Archive button in the tab sequence, so overshooting Save by one Tab
          never lands on Archive (brief §7). */}
      <div className="flex flex-row-reverse justify-start gap-2 pt-1">
        <form.Subscribe selector={(state) => state.values.title}>
          {(title) => (
            <ActionButton
              type="submit"
              size="sm"
              disabled={submitting === true || title.trim() === ''}
              className="disabled:cursor-not-allowed"
            >
              Save
            </ActionButton>
          )}
        </form.Subscribe>
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-3 py-1.5 text-xs text-ink-dim hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
