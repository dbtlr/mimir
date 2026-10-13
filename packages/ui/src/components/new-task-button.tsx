import { useState } from 'react';

import { AuthoringSheet } from './authoring-sheet';

/**
 * The create affordance on the work page's head (project and container) and the
 * board. Opens the authoring sheet (MMR-227) pre-filled to the project, or to
 * `home` when the page is a container.
 */
export function NewTaskButton({
  projectKey,
  offline,
  home,
}: {
  projectKey: string;
  offline?: boolean;
  /** A container id to file into — the sheet opens with it as the home. */
  home?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        aria-label="New task"
        aria-haspopup="dialog"
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
        prefill={home === undefined ? undefined : { home }}
      />
    </>
  );
}
