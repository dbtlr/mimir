import { Dialog } from '@base-ui-components/react/dialog';
import { useState } from 'react';

import { useUpdateDirection } from '../api/mutations';
import type { DirectionTarget } from '../api/mutations';
import { cn } from '../lib/cn';
import { MarkdownBody } from './markdown-body';
import { ActionButton } from './ui/action-button';

/** The subject's on-screen handle — the project key or the node id. */
function subjectId(subject: DirectionTarget): string {
  return subject.kind === 'project' ? subject.key : subject.id;
}

/** `[text](url)` → `text`, `![alt](url)` → `alt`. */
const MARKDOWN_LINK = /!?\[([^\]]*)]\([^)]*\)/g;
/** A paired emphasis/strong run: `**x**`, `__x__`, `*x*`, `_x_` (never bare snake_case). */
const EMPHASIS = /(\*\*|__|\*|_)(?=\S)([\s\S]*?\S)\1/g;
/** Leading block syntax: blockquote marks, ATX hashes, and bullet or ordered markers. */
const LEADING_BLOCK = /^(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)?/;

/**
 * The fold: the first line that carries content, as plain text. The row is a
 * single line of UI chrome, not a markdown surface — an unstripped `**bold**`
 * or `- bullet` would read as literal syntax where the operator expects prose.
 * Returns undefined when there is no direction to fold.
 */
export function foldDirection(next: string | undefined): string | undefined {
  const line = next
    ?.replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  if (line === undefined) {
    return undefined;
  }
  const plain = line
    .replace(LEADING_BLOCK, '')
    .replace(MARKDOWN_LINK, '$1')
    // Twice: the inner run of a nested `**_x_**` needs a second pass.
    .replace(EMPHASIS, '$2')
    .replace(EMPHASIS, '$2')
    .replaceAll('`', '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain === '' ? undefined : plain;
}

/**
 * The folded direction row (MMR-390) — the owned `## Next` prose (ADR 0026
 * Decision 2) stated in one line under the project header and in the
 * initiative/phase dossier. It is a control, not a card: clicking opens the
 * reading dialog, where Edit replaces the whole text. Deliberately one visual
 * line — direction is a pointer to the full record, not the record itself.
 */
export function DirectionLine({
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
  // Open state is held as the subject it was opened FOR, so a surface that
  // swaps subjects under a mounted row (navigating between projects) closes
  // the dialog instead of pointing it at the new record.
  const [openFor, setOpenFor] = useState<string | null>(null);
  const fold = foldDirection(next);
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => {
          setOpenFor(id);
        }}
        className="flex w-full items-center gap-2.5 rounded-lg bg-well-850 px-2.5 py-1.5 text-left inset-ring inset-ring-line transition-colors hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent"
      >
        {/* Not aria-hidden: the microlabel plus the fold IS the button's
            accessible name, so two direction rows on one page are told apart. */}
        <span className="microlabel shrink-0 text-ink-faint">Direction</span>
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-xs',
            fold === undefined ? 'text-ink-ghost' : 'text-ink-dim',
          )}
        >
          {fold ?? 'No direction set'}
        </span>
        <span aria-hidden className="shrink-0 text-ink-faint">
          ›
        </span>
      </button>
      {/* Keyed by subject: the draft belongs to the record it was typed
          against and must never follow the row to another one. */}
      <DirectionDialog
        key={id}
        subject={subject}
        title={title}
        next={next}
        offline={offline}
        open={openFor === id}
        onClose={() => {
          setOpenFor(null);
        }}
      />
    </>
  );
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
}: {
  subject: DirectionTarget;
  title: string;
  next: string | undefined;
  offline: boolean;
  open: boolean;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const update = useUpdateDirection(subject);

  // mutateAsync settles after the hook's awaited invalidation, so view mode
  // returns to the refetched prose rather than flashing the replaced text.
  const handleSave = async (text: string) => {
    try {
      await update.mutateAsync(text);
      setDraft(null);
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
                  onClick={() => {
                    setDraft(null);
                  }}
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
