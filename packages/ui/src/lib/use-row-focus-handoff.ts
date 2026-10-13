import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';

/**
 * The row actions' side of a handoff: `arm(id)` as the operator commits to an
 * action that may move the row, `disarm(id)` once that action is over and the
 * row stayed (useDisarmWhenSettled).
 */
export type RowFocusHandoff = { arm: (id: string) => void; disarm: (id: string) => void };

/**
 * Keeps a keyboard operator in place when a row they acted on leaves its list
 * (MMR-474). Once a refresh drops the armed id from `ids` while focus is on the
 * page body, focus moves to the next surviving row's first enabled action,
 * else its link, or to the list's heading when no row followed it. Focus the
 * operator has moved elsewhere is left alone, and a disarmed row leaving later
 * (a poll) moves nothing.
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

  const handoff = useMemo<RowFocusHandoff>(
    () => ({
      arm: (id) => {
        armed.current = id;
      },
      disarm: (id) => {
        if (armed.current === id) {
          armed.current = null;
        }
      },
    }),
    [],
  );
  return { handoff, headingRef };
}

/**
 * Disarms a row once its action has ended with the row still mounted, so a
 * later refresh that drops the row moves nothing. `settled` is null while the
 * action runs and takes a new value each time one ends (a mutation's
 * `submittedAt`, which also catches a failure too fast to render as pending).
 * It must follow the render, not a mutate callback: TanStack Query runs those
 * before it renders the refetched rows, and a leaving row unmounts first.
 */
export function useDisarmWhenSettled(
  handoff: RowFocusHandoff,
  id: string,
  settled: number | null,
): void {
  const last = useRef(settled);
  useEffect(() => {
    if (settled !== null && settled !== last.current) {
      handoff.disarm(id);
    }
    last.current = settled;
  }, [handoff, id, settled]);
}

/**
 * Nothing on the page holds focus: the removed row or its dialog took it, or
 * a disabled pending button already dropped it.
 */
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
