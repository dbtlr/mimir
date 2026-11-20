import { useState } from 'react';
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
import { useFinalFocus } from './opener';
import type { FinalFocus } from './opener';
import { useOpening } from './opening';

function defaultPlaceholder(required: boolean): string {
  return required
    ? 'Reason (required) — the triage record'
    : 'Reason (optional) — context for the next agent';
}

/** One answer a Reason dialog offers. */
export type ReasonCommit = {
  label: string;
  /**
   * Runs with the trimmed text. A promise holds the dialog open until it
   * settles. It must not reopen this dialog before it returns.
   */
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
  const returnTo = useFinalFocus(open, finalFocus);
  const { busy, commit, key } = useOpening(open, pending);
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
          // Each opening remounts the body, so it starts with an empty box even when the dialog
          // reopens during its exit transition, before the body unmounted.
          key={key}
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
          commit={commit}
          onClose={onClose}
        >
          {children}
        </ReasonBody>
      </DialogContent>
    </Dialog>
  );
}

/** The dialog's content, remounted with each opening so it starts with an empty box. */
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
  commit,
  onClose,
}: Pick<ReasonProps, 'title' | 'description' | 'lead' | 'label' | 'placeholder' | 'children'> & {
  required: boolean;
  commits: ReasonCommit[];
  commitDisabled: boolean;
  closeOnCommit: boolean;
  busy: boolean;
  commit: ReturnType<typeof useOpening>['commit'];
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const trimmed = text.trim();
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
        {commits.map((entry) => (
          <ActionButton
            key={entry.label}
            size="sm"
            variant={entry.variant}
            aria-busy={busy}
            disabled={busy || commitDisabled || (required && trimmed === '')}
            onClick={(event) =>
              void commit(
                event.currentTarget,
                () => entry.onCommit(trimmed),
                () => {
                  if (closeOnCommit) {
                    onClose();
                  }
                },
              )
            }
          >
            {entry.label}
          </ActionButton>
        ))}
      </DialogFooter>
    </>
  );
}
