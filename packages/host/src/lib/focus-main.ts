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
