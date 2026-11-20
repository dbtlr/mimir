import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { ActionButton } from '../ui/action-button';
import type { ActionButtonProps } from '../ui/action-button';
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '../ui/dialog';
import { Field, FieldLabel } from '../ui/field';
import { Textarea } from '../ui/textarea';
import { HELD, useCommitGate } from './commit-gate';
import { useFinalFocus } from './opener';
import type { FinalFocus } from './opener';

function defaultPlaceholder(required: boolean): string {
  return required
    ? 'Reason (required) — the triage record'
    : 'Reason (optional) — context for the next agent';
}

/** One answer a Reason dialog offers. */
export type ReasonCommit = {
  label: string;
  /** Runs with the trimmed text. A promise holds the dialog open until it settles. */
  onCommit: (text: string) => void | Promise<void>;
  /** A destructive commit passes `destructiveOutline`; the default is the solid action. */
  variant?: ActionButtonProps['variant'];
};

export type ReasonProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  /** What the words are for, under the title. */
  description?: ReactNode;
  /** Content between the title and the description, such as the question being answered. */
  lead?: ReactNode;
  /** Names the text box for assistive technology; the box has no visible label. Defaults to "Reason". */
  label?: string;
  /** Defaults to the console's reason copy for an optional or a required reason. */
  placeholder?: string;
  /** A required reason keeps every commit disabled until it holds non-blank text. */
  required?: boolean;
  /** One commit, or two where the dialog offers two answers. */
  commits: ReasonCommit[];
  /**
   * Further controls under the text box; they decide `commitDisabled`.
   * Transitional: a Choice pattern only. The grooming answer's radios move to
   * the Choice pattern (UI SDK Radio) with MMR-731; a feature passes no raw inputs.
   */
  children?: ReactNode;
  /** Disables every commit for a reason beyond the text, such as offline or a missing choice. */
  commitDisabled?: boolean;
  /**
   * Close after a commit returns or resolves (the default). A caller that
   * closes itself once the result renders passes `false` and `pending`.
   */
  closeOnCommit?: boolean;
  /** A call the caller runs is in flight: commits disable and the dialog holds. */
  pending?: boolean;
  /** Where focus goes on close, for an opener that is not a trigger the dialog knows. */
  finalFocus?: FinalFocus;
};

/**
 * Reason (ADR 0019, MMR-736): use it for an action that takes words before it
 * runs, and is its own confirm: parking, blocking, abandoning, returning,
 * rejecting, answering. The text is optional, or required to enable the
 * commit. A dialog offers one commit, or two where it has two answers. A
 * commit that ends something wears the destructive variant. The dialog opens
 * on the text box and holds while a commit is pending; a failed commit keeps
 * the dialog and the text, and focus returns to the commit.
 */
export function Reason({
  open,
  onClose,
  title,
  description,
  lead,
  label = 'Reason',
  placeholder,
  required = false,
  commits,
  children,
  commitDisabled = false,
  closeOnCommit = true,
  pending = false,
  finalFocus,
}: ReasonProps) {
  const [running, setRunning] = useState(false);
  const busy = running || pending;
  const returnTo = useFinalFocus(open, finalFocus);
  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (next) {
          return;
        }
        if (busy) {
          details.cancel();
        } else {
          onClose();
        }
      }}
    >
      <DialogBackdrop />
      <DialogContent finalFocus={returnTo}>
        <ReasonBody
          title={title}
          description={description}
          lead={lead}
          label={label}
          placeholder={placeholder}
          required={required}
          commits={commits}
          commitDisabled={commitDisabled}
          closeOnCommit={closeOnCommit}
          busy={busy}
          onRunning={setRunning}
          onClose={onClose}
        >
          {children}
        </ReasonBody>
      </DialogContent>
    </Dialog>
  );
}

/** The dialog's content, mounted only while open so each opening starts with an empty box. */
function ReasonBody({
  title,
  description,
  lead,
  label,
  placeholder,
  required,
  commits,
  children,
  commitDisabled,
  closeOnCommit,
  busy,
  onRunning,
  onClose,
}: Pick<ReasonProps, 'title' | 'description' | 'lead' | 'label' | 'placeholder' | 'children'> & {
  required: boolean;
  commits: ReasonCommit[];
  commitDisabled: boolean;
  closeOnCommit: boolean;
  busy: boolean;
  onRunning: (running: boolean) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const trimmed = text.trim();
  // Closed synchronously on the first click, so a second one in the same task is held.
  const gate = useCommitGate();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  // A failed commit disables while it runs, which drops focus to the page; it takes focus back
  // once enabled again, so a keyboard or screen-reader user stays in the dialog.
  const [refused, setRefused] = useState<number | null>(null);
  const refocused = useRef<number | null>(null);
  useEffect(() => {
    if (refused !== null && refused !== refocused.current && !busy) {
      refocused.current = refused;
      buttons.current[refused]?.focus();
    }
  }, [refused, busy]);

  /**
   * A commit that returns nothing has handed its work on, so the dialog closes
   * in the same tick. One that returns a promise holds the dialog until it settles.
   */
  async function commit(index: number, { onCommit }: ReasonCommit) {
    let result: void | Promise<void> | typeof HELD;
    try {
      result = gate(() => onCommit(trimmed));
    } catch {
      setRefused(index);
      return;
    }
    if (result === HELD) {
      return;
    }
    if (!(result instanceof Promise)) {
      if (closeOnCommit) {
        onClose();
      }
      return;
    }
    onRunning(true);
    try {
      await result;
      if (closeOnCommit) {
        onClose();
      }
    } catch {
      // The caller's mutation reports the refusal; keep the text for another attempt.
      setRefused(index);
    } finally {
      onRunning(false);
    }
  }

  return (
    <>
      <DialogTitle>{title}</DialogTitle>
      {lead}
      {description !== undefined && <DialogDescription>{description}</DialogDescription>}
      <Field>
        <FieldLabel className="sr-only">{label}</FieldLabel>
        <Textarea
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- a Reason dialog opens on its text box
          autoFocus
          value={text}
          placeholder={placeholder ?? defaultPlaceholder(required)}
          onChange={(event) => setText(event.target.value)}
        />
      </Field>
      {children}
      <DialogFooter className="flex-wrap">
        <DialogClose disabled={busy} render={<ActionButton size="sm" variant="outline" />}>
          Cancel
        </DialogClose>
        {commits.map((entry, index) => (
          <ActionButton
            key={entry.label}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            size="sm"
            variant={entry.variant}
            aria-busy={busy}
            disabled={busy || commitDisabled || (required && trimmed === '')}
            onClick={() => void commit(index, entry)}
          >
            {entry.label}
          </ActionButton>
        ))}
      </DialogFooter>
    </>
  );
}
