import { useState } from "react";
import { useForm } from "@tanstack/react-form";
import { useUpdateProject } from "../api/mutations";
import { Sheet, SheetContent, SheetTitle } from "./ui/sheet";
import type { WireNode } from "../api/types";

export interface ProjectFormValues {
  title: string;
  description: string;
}

/**
 * Modest settings affordance for the active project board header. Opens a
 * Sheet letting the user rename the project and edit its description.
 */
export function ProjectSettingsButton({
  project,
  offline,
}: {
  project: WireNode;
  offline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const update = useUpdateProject(project.id);

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
              <SheetTitle className="text-md font-semibold text-ink-bright">
                Project settings
              </SheetTitle>
              <ProjectSettingsForm
                project={project}
                submitting={update.isPending}
                onSubmit={(values) => {
                  update.mutate(values, { onSuccess: () => setOpen(false) });
                }}
                onCancel={() => setOpen(false)}
              />
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
      title: project.title,
      description: project.description ?? "",
    } satisfies ProjectFormValues,
    onSubmit: ({ value }) => {
      const title = value.title.trim();
      if (title === "") return;
      onSubmit({
        title,
        description: value.description.trim(),
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

      {/* Buttons */}
      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-3 py-1.5 text-xs text-ink-dim hover:text-ink"
        >
          Cancel
        </button>
        <form.Subscribe selector={(state) => state.values.title}>
          {(title) => (
            <button
              type="submit"
              disabled={submitting === true || title.trim() === ""}
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-well-950 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Save
            </button>
          )}
        </form.Subscribe>
      </div>
    </form>
  );
}
