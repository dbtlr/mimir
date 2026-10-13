import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * Keeps a keyboard operator in place when a row they acted on leaves its list
 * (MMR-474). `arm(id)` marks the row an action came from. Once a refresh drops
 * that id from `ids` while focus has fallen to the page, focus moves to the
 * next surviving row's first enabled action, else its link, or to the list's
 * heading when no row followed it. Focus the operator has moved elsewhere is
 * left alone.
 *
 * Rows are found by `data-row-id` inside the heading's section (BrowserRow),
 * so `headingRef` must sit on a heading that can take focus (BrowserGroup).
 */
export function useRowFocusHandoff(ids: readonly string[]) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const armed = useRef<string | null>(null);
  const previous = useRef(ids);

  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = ids;
    const id = armed.current;
    if (id === null || ids.includes(id)) {
      return;
    }
    armed.current = null;
    if (!focusIsLost()) {
      return;
    }
    const next = before.slice(before.indexOf(id) + 1).find((n) => ids.includes(n));
    const heading = headingRef.current;
    const row =
      next === undefined
        ? null
        : heading?.closest('section')?.querySelector(`[data-row-id="${CSS.escape(next)}"]`);
    (row == null ? heading : rowTarget(row))?.focus();
  });

  const arm = useCallback((id: string) => {
    armed.current = id;
  }, []);
  return { arm, headingRef };
}

/** The removed row took focus with it, or a dialog it opened did. */
function focusIsLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body;
}

function rowTarget(row: Element): HTMLElement | null {
  return (
    row.querySelector<HTMLElement>('[data-row-actions] button:not(:disabled)') ??
    row.querySelector<HTMLElement>('a')
  );
}
