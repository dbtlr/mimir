import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { treeQuery } from "../api/queries";
import { useCreateTask } from "../api/mutations";
import { parentOptions } from "../lib/parent-options";
import { TaskForm } from "./task-form";
import type { TaskFormSubmit } from "./task-form";
import { Sheet, SheetContent, SheetTitle } from "./ui/sheet";

export function NewTaskButton({ projectKey, offline }: { projectKey: string; offline?: boolean }) {
  const [open, setOpen] = useState(false);
  const tree = useQuery({ ...treeQuery(projectKey), enabled: open });
  const create = useCreateTask();

  function handleSubmit(values: TaskFormSubmit) {
    const { parent, title, description, priority, size, external_ref, tags } = values;
    create.mutate(
      {
        parent: parent ?? "",
        title,
        description: description ?? undefined,
        priority: priority ?? undefined,
        size: size ?? undefined,
        external_ref: external_ref ?? undefined,
        tags,
      },
      { onSuccess: () => setOpen(false) },
    );
  }

  return (
    <>
      <button
        type="button"
        aria-label="New task"
        disabled={offline === true}
        onClick={() => setOpen(true)}
        className="rounded border border-line bg-well-850 px-3 py-1.5 text-xs font-medium whitespace-nowrap text-ink transition-colors hover:bg-well-800 hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40"
      >
        +<span className="hidden sm:inline"> New task</span>
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        {open && (
          <SheetContent aria-describedby={undefined}>
            <div className="flex flex-col gap-4 p-4">
              <SheetTitle className="text-md font-semibold text-ink-bright">New task</SheetTitle>
              <TaskForm
                mode="create"
                parents={tree.data ? parentOptions(tree.data) : []}
                submitting={create.isPending || tree.isPending}
                onSubmit={handleSubmit}
                onCancel={() => setOpen(false)}
              />
            </div>
          </SheetContent>
        )}
      </Sheet>
    </>
  );
}
