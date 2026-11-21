import { useRef, useState } from 'react';

import { ActionButton } from '../ui/action-button';
import { Field, FieldLabel } from '../ui/field';
import { Textarea } from '../ui/textarea';
import { useOpening } from './opening';

export type ComposerProps = {
  /** Names the text box for assistive technology; the box has no visible label. */
  label: string;
  placeholder?: string;
  /** The commit's visible text, such as "Append". */
  commitLabel: string;
  /** The commit's accessible name when it says more than its label, such as "Append note". */
  commitName?: string;
  /**
   * Runs with the trimmed text. A call to the host returns its promise (a
   * mutation's `mutateAsync`): the text holds, read-only, until it settles,
   * and the box empties when it resolves. A rejection keeps the text; the
   * caller's call reports why.
   */
  onCommit: (text: string) => void | Promise<void>;
  /** Neither the box nor the commit takes input, as while offline. Typed text stays. */
  disabled?: boolean;
};

/**
 * The commit's look: the accent wash of the source mock, at the 44px height
 * of the box beside it. Disabled, it is the quiet button (DESIGN.md, Color
 * roles), which the `action` variant already draws.
 */
const COMMIT_CLASS = 'bg-accent/14 text-accent-foreground hover:bg-accent/20';

/** Focus fell with the commit as it disabled, or stayed on it: the box takes it for the next note. */
function refocusBox(box: HTMLTextAreaElement | null, button: HTMLButtonElement) {
  if (box === null) {
    return;
  }
  const { activeElement, body } = box.ownerDocument;
  if (activeElement === null || activeElement === body || activeElement === button) {
    box.focus();
  }
}

/**
 * Composer (ADR 0019, MMR-736): use it for text added in place, such as a
 * node's annotation. An inline text box that starts one line tall and grows
 * to four (Textarea `grow`), with its one commit beside it. The commit waits
 * for non-blank text and runs once at a time; while it runs the text is
 * read-only. A resolved commit empties the box and gives it focus back; a
 * refused one keeps the text and returns focus to the commit.
 */
export function Composer({
  label,
  placeholder,
  commitLabel,
  commitName,
  onCommit,
  disabled = false,
}: ComposerProps) {
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement | null>(null);
  // An inline composer is always open: one opening for its life, so a commit still holds the gate.
  const { busy, commit } = useOpening(true, false, disabled, { restoreFocusOnResolve: false });
  const trimmed = text.trim();
  return (
    <div className="flex items-end gap-2">
      <Field className="min-w-0 flex-1">
        <FieldLabel className="sr-only">{label}</FieldLabel>
        <Textarea
          ref={box}
          grow
          value={text}
          readOnly={busy}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(event) => setText(event.target.value)}
        />
      </Field>
      <ActionButton
        size="form"
        className={COMMIT_CLASS}
        aria-label={commitName}
        aria-busy={busy}
        disabled={disabled || busy || trimmed === ''}
        onClick={(event) => {
          const button = event.currentTarget;
          void commit(
            button,
            () => onCommit(trimmed),
            () => {
              setText('');
              refocusBox(box.current, button);
            },
          );
        }}
      >
        {commitLabel}
      </ActionButton>
    </div>
  );
}
