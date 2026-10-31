import { Dialog } from '@base-ui-components/react/dialog';
import { useRef, useState } from 'react';

import { useUpdateDirection } from '../api/node-mutations';
import type { DirectionTarget } from '../api/node-mutations';
import { cn } from '../lib/cn';
import { proseEdit } from '../lib/prose';
import { PHONE_TOUCH_TARGET } from '../lib/touch-target';
import { MarkdownBody } from './markdown-body';
import type { ClampMeasure } from './markdown-body';
import { ActionButton } from './ui/action-button';

/** The subject's on-screen handle — the project key or the node id. */
function subjectId(subject: DirectionTarget): string {
  return subject.kind === 'project' ? subject.key : subject.id;
}

/**
 * The reading pane for a subject's direction, with the rewrite in place.
 * `draft === null` is view mode; a string is the editor's whole-text buffer.
 * Escape and the backdrop close outright — the draft is a scratch rewrite of
 * text the agents re-author anyway, so a confirm would cost more than it saves.
 * Save is a blind whole-text replace: the PATCH carries no version token, so
 * the last writer wins.
 */
function DirectionDialog({
  subject,
  title,
  next,
  offline,
  open,
  onClose,
  finalFocus,
  editOnly = false,
}: {
  subject: DirectionTarget;
  title: string;
  next: string | undefined;
  offline: boolean;
  open: boolean;
  onClose: () => void;
  /** Where focus lands when the dialog closes; the opener may be gone by then. */
  finalFocus: () => HTMLElement | null;
  /** Open straight into the editor, and close on Save or Cancel: the caller
   * already shows the text, so there is no reading view to return to. */
  editOnly?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(editOnly ? (next ?? '') : null);
  const update = useUpdateDirection(subject);

  const leaveEditor = () => {
    if (editOnly) {
      onClose();
    } else {
      setDraft(null);
    }
  };

  // mutateAsync settles after the hook's awaited invalidation, so view mode
  // returns to the refetched prose rather than flashing the replaced text.
  const handleSave = async (text: string) => {
    try {
      await update.mutateAsync(proseEdit(text, next));
      leaveEditor();
    } catch {
      // The hook toasts the cause; the draft stays put so it isn't lost.
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setDraft(null);
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
          <header className="flex items-center gap-2.5 border-b border-line px-5 py-3.5">
            <Dialog.Title className="microlabel text-ink-faint">Direction</Dialog.Title>
            <span className="shrink-0 font-mono text-mono-id text-ink-faint">
              {subjectId(subject)}
            </span>
            <span className="min-w-0 truncate text-tag text-ink-dim">{title}</span>
            <Dialog.Close
              aria-label="Close"
              className="ml-auto rounded px-2 py-1 text-ink-faint transition-colors hover:bg-well-800 hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent"
            >
              ✕
            </Dialog.Close>
          </header>

          {draft === null ? (
            <>
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {next === undefined || next.trim() === '' ? (
                  <p className="text-xs text-ink-ghost">No direction set</p>
                ) : (
                  <MarkdownBody>{next}</MarkdownBody>
                )}
              </div>
              <div className="flex justify-end border-t border-line px-5 py-3">
                <ActionButton
                  size="sm"
                  disabled={offline}
                  onClick={() => {
                    setDraft(next ?? '');
                  }}
                >
                  Edit
                </ActionButton>
              </div>
            </>
          ) : (
            <>
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
                <p className="min-w-0 flex-1 truncate text-tag text-ink-faint">
                  Replaces the whole text. Agents rewrite this at session end.
                </p>
                <button
                  type="button"
                  onClick={leaveEditor}
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
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The direction in rail form (MMR-450, MMR-484): the owned `## Next` prose
 * rendered as markdown, clamped to six lines so a long rewrite cannot push the
 * rest of the rail off screen. "Read more" appears only when the text really
 * overflows and opens the reading dialog; Edit opens the whole-text rewrite.
 */
export function DirectionPanel({
  subject,
  title,
  next,
  offline,
}: {
  subject: DirectionTarget;
  title: string;
  next: string | undefined;
  offline: boolean;
}) {
  const id = subjectId(subject);
  // Held as the subject it was opened FOR, like the open dialog: the project
  // page does not remount between projects, and a draft must never follow the
  // panel to another record's direction.
  const [openFor, setOpenFor] = useState<{ id: string; mode: 'read' | 'edit' } | null>(null);
  if (openFor !== null && openFor.id !== id) {
    setOpenFor(null);
  }
  const [measure, setMeasure] = useState<ClampMeasure>({ lines: 0, overflowing: false });
  const empty = next === undefined || next.trim() === '';
  const editRef = useRef<HTMLButtonElement>(null);
  const readMoreRef = useRef<HTMLButtonElement>(null);
  // A rewrite can shorten the text until Read more unmounts under the open
  // dialog; Edit is always mounted, so it is the stable place to land.
  const settleFocus = () =>
    readMoreRef.current?.isConnected === true ? readMoreRef.current : editRef.current;
  return (
    <div className="flex flex-col gap-2">
      {empty ? (
        <p className="text-xs text-ink-ghost">No direction set</p>
      ) : (
        <MarkdownBody className="max-w-none" clamp={6} onClampMeasure={setMeasure}>
          {next}
        </MarkdownBody>
      )}
      <div className="flex items-center gap-3">
        <ActionButton
          ref={editRef}
          size="sm"
          variant="outline"
          aria-label="Edit direction"
          aria-haspopup="dialog"
          disabled={offline}
          onClick={() => {
            setOpenFor({ id, mode: 'edit' });
          }}
        >
          Edit
        </ActionButton>
        {!empty && measure.overflowing && (
          <button
            ref={readMoreRef}
            type="button"
            aria-label="Read more of the direction"
            aria-haspopup="dialog"
            onClick={() => {
              setOpenFor({ id, mode: 'read' });
            }}
            className={cn(
              'inline-flex min-h-6 items-center rounded-sm px-1.5 text-micro text-accent-foreground transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-accent',
              PHONE_TOUCH_TARGET,
            )}
          >
            Read more
          </button>
        )}
      </div>
      {/* Mounted only while open, so each opening drafts from the current
          text; keyed by subject and mode so a draft never carries over. */}
      {openFor !== null && (
        <DirectionDialog
          key={`${id}:${openFor.mode}`}
          subject={subject}
          title={title}
          next={next}
          offline={offline}
          open
          finalFocus={settleFocus}
          editOnly={openFor.mode === 'edit'}
          onClose={() => {
            setOpenFor(null);
          }}
        />
      )}
    </div>
  );
}
