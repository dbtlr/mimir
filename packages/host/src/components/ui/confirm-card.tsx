import { useId } from 'react';
import type { ElementType, ReactNode, Ref } from 'react';

import { cn } from '../../lib/cn';
import { ActionButton } from './action-button';
import type { ActionButtonProps } from './action-button';
import { cardVariants } from './card';

/** One of a confirm card's buttons. */
export type ConfirmCardAction = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** The button's look; the confirm defaults to the solid action, the cancel to the outline. */
  variant?: ActionButtonProps['variant'];
  /** Take focus when the button appears, as a way out that replaces the button just pressed. */
  autoFocus?: boolean;
  /**
   * Distinguishes this button from the one it replaces in the same slot, so a
   * swapped-in button mounts afresh (and `autoFocus` fires) instead of reusing a node.
   */
  key?: string;
  /** The button element, for a caller that returns focus to it. */
  ref?: Ref<HTMLButtonElement>;
};

export type ConfirmCardProps = {
  title: ReactNode;
  /**
   * The title's element. A card on a page uses a heading; inside a Sheet or
   * Dialog, pass its title component, so the dialog is named by it.
   */
  titleAs?: ElementType;
  /** What the choice means, in a sentence or two. */
  children?: ReactNode;
  /** The answer to the last action, announced politely when it changes. */
  notice?: ReactNode;
  /** The action the card asks for. Leave it out once there is nothing left to confirm. */
  confirm?: ConfirmCardAction;
  /** The way out: Cancel, Not now, or Close. */
  cancel?: ConfirmCardAction;
  /**
   * `card` stands alone on a page as a region named by its title. `bare` sits
   * inside a Sheet, Dialog, or Popover, which supplies the frame and the name.
   */
  surface?: 'card' | 'bare';
  /** Button density; defaults to `default` on a card and `sm` in a sheet or dialog footer. */
  size?: ActionButtonProps['size'];
  className?: string;
  /** The `card` frame, which can take focus (tabIndex -1) while its buttons are gone. */
  ref?: Ref<HTMLElement>;
};

/** One action's button, in its own look or the card's default for its place. */
function ActionOf({
  action: { autoFocus, disabled, label, onClick, ref, variant },
  look,
  size,
}: {
  action: ConfirmCardAction;
  look: ActionButtonProps['variant'];
  size: ActionButtonProps['size'];
}) {
  return (
    <ActionButton
      size={size}
      variant={variant ?? look}
      disabled={disabled}
      // oxlint-disable-next-line jsx-a11y/no-autofocus -- a way out that replaces the pressed button keeps focus in the card
      autoFocus={autoFocus}
      ref={ref}
      onClick={onClick}
    >
      {label}
    </ActionButton>
  );
}

/**
 * A yes-or-no ask (ADR 0019's MMR-734 refinement): a title, what the choice
 * means, an optional answer line, and a confirm beside its way out. One shape
 * for a suggestion on a page and for a confirmation in a sheet, dialog, or
 * popover, so a new ask picks a surface rather than a new layout. A confirm of
 * an action stays a modal, so it uses the `bare` surface; `card` is for a
 * suggestion the page offers, never for confirming a destructive action.
 */
export function ConfirmCard({
  title,
  titleAs: Title = 'h2',
  children,
  notice,
  confirm,
  cancel,
  surface = 'card',
  size,
  className,
  ref,
}: ConfirmCardProps) {
  const titleId = useId();
  const standalone = surface === 'card';
  const density = size ?? (standalone ? 'default' : 'sm');
  const body = (
    <>
      <Title id={titleId} className="text-sm font-semibold text-ink-bright">
        {title}
      </Title>
      {children !== undefined && <div className="text-xs text-ink-dim">{children}</div>}
      <div aria-live="polite" className="text-xs font-medium text-ink-bright empty:hidden">
        {notice}
      </div>
      {(confirm !== undefined || cancel !== undefined) && (
        <div className="flex flex-wrap justify-end gap-2">
          {cancel !== undefined && (
            <ActionOf key={cancel.key} action={cancel} size={density} look="outline" />
          )}
          {confirm !== undefined && (
            <ActionOf key={confirm.key} action={confirm} size={density} look="action" />
          )}
        </div>
      )}
    </>
  );
  if (!standalone) {
    return <div className={cn('flex flex-col gap-3', className)}>{body}</div>;
  }
  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-labelledby={titleId}
      className={cn('flex flex-col gap-3 p-4', cardVariants(), className)}
    >
      {body}
    </section>
  );
}
