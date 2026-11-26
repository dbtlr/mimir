import { useEffect } from 'react';
import type { RefObject } from 'react';

/**
 * Focus the page's `<main>`. Pages mark their main focusable; one that does
 * not is made focusable here, so it still takes focus. Used by the skip link
 * and as the last fallback when a control that should take focus is gone.
 */
export function focusMain(): void {
  const main = document.querySelector('main');
  if (main === null) {
    return;
  }
  if (!main.hasAttribute('tabindex')) {
    main.tabIndex = -1;
  }
  main.focus();
}

/**
 * Focus the page's `<main>` and return it, as a `finalFocus` for an overlay
 * whose trigger or row is gone. It returns null when no `<main>` took focus.
 */
export function focusPage(): HTMLElement | null {
  focusMain();
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

/**
 * Hand on the focus a block holds when it leaves: on unmount, or once
 * `present` turns false. A focused control that goes with the block drops
 * focus to the document; while the block held it, `to` takes it, else the
 * page's `<main>`. Focus the block did not hold stays where it is.
 */
export function useFocusHandoff({
  block,
  present = true,
  to,
}: {
  block: RefObject<HTMLElement | null>;
  present?: boolean;
  to?: RefObject<HTMLElement | null>;
}): void {
  useEffect(() => {
    const shown = block.current;
    if (!present || shown === null) {
      return undefined;
    }
    let held = shown.contains(document.activeElement);
    const enter = () => {
      held = true;
    };
    const leave = () => {
      // Read once the move settles. A browser may blur a focused control as the block is
      // removed; a block that is gone still holds the focus it dropped.
      queueMicrotask(() => {
        if (shown.isConnected) {
          held = shown.contains(document.activeElement);
        }
      });
    };
    shown.addEventListener('focusin', enter);
    shown.addEventListener('focusout', leave);
    return () => {
      shown.removeEventListener('focusin', enter);
      shown.removeEventListener('focusout', leave);
      const active = document.activeElement;
      if (held && (active === null || active === document.body)) {
        const target = to?.current ?? null;
        if (target === null) {
          focusMain();
        } else {
          target.focus();
        }
      }
    };
  }, [block, present, to]);
}
