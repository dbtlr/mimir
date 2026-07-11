import { useState } from 'react';

import { AuthoringSheet } from './authoring-sheet';

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
        onClick={() => setOpen(true)}
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
