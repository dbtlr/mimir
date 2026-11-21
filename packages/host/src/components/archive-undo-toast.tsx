import { toast } from './patterns/notice';

/**
 * The undo Notice shown after archiving a project (MMR-125, shared with
 * MMR-230's Archive action): `Archived <title>` with an inline Undo (ADR 0019,
 * the MMR-736 refinement's rule 4). Deliberately the ONLY safety on archive:
 * there is no confirm dialog on either side; Undo unarchives.
 *
 * `duration` overrides the toast's five-second default. The project-settings
 * Archive (MMR-230) passes a longer window: it may still be the nearest
 * recovery affordance at the moment of archive, so it holds longer than a
 * passing confirmation would.
 */
export function archivedUndoToast(
  title: string,
  onUnarchive: () => void,
  options?: { duration?: number },
): void {
  // The project's name is ink-bright 600 in the Notice's ink line (DESIGN.md, Toast).
  toast(
    <>
      Archived <b>{title}</b>
    </>,
    {
      action: { label: 'Undo', onClick: onUnarchive },
      duration: options?.duration,
    },
  );
}
