import { toast } from 'sonner';

/**
 * The undo toast shown after archiving a project (MMR-125, shared with
 * MMR-230's Archive action): `Archived <title>` with an inline Unarchive.
 * Deliberately the ONLY safety on archive — there is no confirm dialog on
 * either side; unarchive IS the undo (ADR 0015, G21).
 *
 * `duration` overrides sonner's ~4s default. The project-settings Archive
 * (MMR-230) passes a longer window: it may still be the nearest recovery
 * affordance at the moment of archive, so it holds longer than a passing
 * confirmation would.
 */
export function archivedUndoToast(
  title: string,
  onUnarchive: () => void,
  options?: { duration?: number },
): void {
  toast(
    <span className="text-ink">
      Archived <b className="font-semibold text-ink-bright">{title}</b>
    </span>,
    {
      action: { label: 'Unarchive', onClick: onUnarchive },
      actionButtonStyle: {
        background: 'transparent',
        color: 'var(--color-accent-foreground)',
        fontWeight: 600,
      },
      duration: options?.duration,
    },
  );
}
