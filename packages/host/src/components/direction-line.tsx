import { Dialog } from '@base-ui-components/react/dialog';
import { useState } from 'react';

import { useUpdateDirection } from '../api/node-mutations';
import type { DirectionTarget } from '../api/node-mutations';
import { cn } from '../lib/cn';
import { proseEdit } from '../lib/prose';
import { ActionButton } from './ui/action-button';
import { iconButtonClass } from './ui/icon-button';
import { CloseIcon } from './ui/icons';

/** The subject's on-screen handle — the project key or the node id. */
function subjectId(subject: DirectionTarget): string {
  return subject.kind === 'project' ? subject.key : subject.id;
}

/**
 * The whole-text rewrite of a subject's direction, opened from a record's
 * More (MMR-726). Save or Cancel closes it. Escape and the backdrop close
 * outright — the draft is a scratch rewrite of text the agents re-author
 * anyway, so a confirm would cost more than it saves. Save is a blind
 * whole-text replace: the PATCH carries no version token, so the last writer
 * wins.
 */
export function DirectionDialog({
  subject,
  title,
  next,
  open,
  onClose,
  finalFocus,
}: {
  subject: DirectionTarget;
  title: string;
  next: string | undefined;
  open: boolean;
  onClose: () => void;
  /** Where focus lands when the dialog closes; the opener may be gone by then. */
  finalFocus: () => HTMLElement | null;
}) {
  const [draft, setDraft] = useState(next ?? '');
  const update = useUpdateDirection(subject);

  // mutateAsync settles after the hook's awaited invalidation, so the page
  // shows the refetched prose rather than flashing the replaced text.
  const handleSave = async (text: string) => {
    try {
      await update.mutateAsync(proseEdit(text, next));
      onClose();
    } catch {
      // The hook toasts the cause; the draft stays put so it isn't lost.
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[60] bg-well-950/70 backdrop-blur-[2px]" />
        <Dialog.Popup
          finalFocus={finalFocus}
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-[60] flex max-h-[85dvh] w-[min(92vw,640px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line-bright bg-well-850 shadow-2xl outline-none light:shadow-overlay"
        >
          <header className="flex items-center gap-2.5 border-b border-line px-5 py-3.5 text-meta">
            <Dialog.Title className="microlabel text-ink-dim">Direction</Dialog.Title>
            <span className="shrink-0 font-mono text-ink-dim">{subjectId(subject)}</span>
            <span className="min-w-0 truncate text-ink-dim">{title}</span>
            <Dialog.Close aria-label="Close" className={cn(iconButtonClass, '-mr-2 ml-auto')}>
              <CloseIcon />
            </Dialog.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <textarea
              autoFocus
              aria-label="Direction text"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
              }}
              className="min-h-60 w-full resize-y rounded border border-line bg-well-900 p-2.5 text-xs leading-[1.7] text-ink outline-none focus-visible:border-accent"
            />
          </div>
          <div className="flex items-center gap-2.5 border-t border-line px-5 py-3">
            <p className="min-w-0 flex-1 truncate text-tag text-ink-dim">
              Replaces the whole text. Agents rewrite this at session end.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="rounded px-3 py-1.5 text-xs text-ink-dim hover:text-ink"
            >
              Cancel
            </button>
            <ActionButton
              size="sm"
              disabled={update.isPending}
              onClick={() => {
                void handleSave(draft);
              }}
            >
              Save
            </ActionButton>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
