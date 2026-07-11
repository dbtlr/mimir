import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { useCreateNode } from '../api/mutations';
import { treeQuery } from '../api/queries';
import { parentOptions } from '../lib/parent-options';
import { AuthoringSheet } from './authoring-sheet';
import { TaskForm } from './task-form';
import type { TaskFormSubmit } from './task-form';
import { Sheet, SheetContent, SheetTitle } from './ui/sheet';

/**
 * The create sheet on its own (MMR-228) — the tasks browser sites its trigger
 * elsewhere (an ActionButton behind a project pick), so the sheet is
 * controlled from outside. Interim scaffold retired once the tasks browser
 * moves onto the shared `AuthoringSheet` (MMR-227).
 */
export function NewTaskSheet({
  projectKey,
  open,
  onOpenChange,
}: {
  projectKey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const tree = useQuery({ ...treeQuery(projectKey), enabled: open });
  const create = useCreateNode();

  function handleSubmit(values: TaskFormSubmit) {
    const { parent, title, description, summary, priority, size, external_ref, tags } = values;
    create.mutate(
      {
        description: description ?? undefined,
        external_ref: external_ref ?? undefined,
        parent: parent ?? '',
        priority: priority ?? undefined,
        size: size ?? undefined,
        summary: summary ?? undefined,
        tags,
        title,
        type: 'task',
      },
      {
        onSuccess: () => {
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {open && (
        <SheetContent aria-describedby={undefined}>
          <div className="flex flex-col gap-4 p-4">
            <SheetTitle className="text-card-mobile font-semibold text-ink-bright">
              New task
            </SheetTitle>
            <TaskForm
              mode="create"
              parents={tree.data ? parentOptions(tree.data) : []}
              submitting={create.isPending || tree.isPending}
              onSubmit={handleSubmit}
              onCancel={() => {
                onOpenChange(false);
              }}
            />
          </div>
        </SheetContent>
      )}
    </Sheet>
  );
}

/**
 * The board header's create affordance. Opens the Meridian authoring sheet
 * (MMR-227) — task / phase / initiative behind a type selector — pre-filled to
 * the current project. Replaces the retired `TaskForm mode="create"` path.
 */
export function NewTaskButton({
  projectKey,
  offline,
  onOpenNode,
}: {
  projectKey: string;
  offline?: boolean;
  /** "Create & open" routes the fresh node here (`?node=<id>`). */
  onOpenNode?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        aria-label="New task"
        disabled={offline === true}
        onClick={() => {
          setOpen(true);
        }}
        className="rounded border border-line bg-well-850 px-3 py-1.5 text-xs font-medium whitespace-nowrap text-ink transition-colors hover:bg-well-800 hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40"
      >
        +<span className="hidden sm:inline"> New task</span>
      </button>

      <AuthoringSheet
        open={open}
        onOpenChange={setOpen}
        projectKey={projectKey}
        offline={offline}
        onOpenNode={onOpenNode}
      />
    </>
  );
}
