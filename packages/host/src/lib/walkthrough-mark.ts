import { useRouter, useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';

/*
 * The in-app mark (ADR 0019, MMR-704 refinement: Leaving a walkthrough an
 * entry opened). An entry pushes the walkthrough with a mark in its history
 * entry's state: the path of the page the entry was on, the opener, and which
 * entry it was (MMR-714 refinement). History state survives a reload. Pure
 * helpers decide where Close and the link back go; the hooks read the mark
 * from the router and act on those decisions.
 */

const OPENER_KEY = 'walkthroughOpener';
const ENTRY_KEY = 'walkthroughEntry';

/** The attribute that names an entry on the page, so focus can find it again after going back. */
export const ENTRY_ATTRIBUTE = 'data-walkthrough-entry';

/** The entry name of every entry in the Needs you popover: its trigger takes focus back, as the popover is closed. */
export const NEEDS_YOU_ENTRY = 'needs-you';

/**
 * Where a walkthrough was opened: the opener's path, and the name of the
 * entry. A mark written before entries were named carries no entry.
 */
export type Mark = { opener: string; entry: string | undefined };

/** The history state of an entry that opens a walkthrough, or undefined for no mark. */
export function markState(mark: Mark | undefined): Record<string, string> | undefined {
  if (mark === undefined) {
    return undefined;
  }
  return mark.entry === undefined
    ? { [OPENER_KEY]: mark.opener }
    : { [ENTRY_KEY]: mark.entry, [OPENER_KEY]: mark.opener };
}

/** The mark recorded in a history entry's state, or undefined when it is unmarked. */
export function readMark(state: unknown): Mark | undefined {
  if (typeof state !== 'object' || state === null) {
    return undefined;
  }
  const opener: unknown = Reflect.get(state, OPENER_KEY);
  const entry: unknown = Reflect.get(state, ENTRY_KEY);
  return typeof opener === 'string'
    ? { entry: typeof entry === 'string' ? entry : undefined, opener }
    : undefined;
}

/**
 * The link back to the page goes back when the walkthrough was opened from
 * that very page, so history holds no second copy of it; otherwise it replaces.
 */
export function linkBackAction(opener: string | undefined, pagePath: string): 'back' | 'replace' {
  return opener === pagePath ? 'back' : 'replace';
}

/*
 * The one focus request a going-back leaves for the opener page: module
 * state, because the walkthrough that sets it unmounts before the page it
 * asks shows. One console runs one router, so there is one request at most.
 */
let pendingFocus: { entry: string | undefined } | undefined;

/** Ask the next page the router shows to focus the entry named `entry`, or the page when it is gone. */
export function requestOpenerFocus(entry: string | undefined): void {
  pendingFocus = { entry };
}

/** The pending focus request, removed as it is taken. */
export function takeOpenerFocus(): { entry: string | undefined } | undefined {
  const request = pendingFocus;
  pendingFocus = undefined;
  return request;
}

/** The current history entry's mark, if the walkthrough was opened in-app. */
export function useOpenerMark(): Mark | undefined {
  return useRouterState({ select: (s) => readMark(s.location.state) });
}

/** The path of the page an entry is on: the opener it records. */
export function useOpenerPath(): string {
  return useRouterState({ select: (s) => s.location.pathname });
}

/** Go back one history entry to the opener, asking it to focus the entry that opened the walkthrough. */
export function useBackToOpener(): (mark: Mark) => void {
  const router = useRouter();
  return (mark) => {
    requestOpenerFocus(mark.entry);
    router.history.back();
  };
}

/** The element a focus request lands on: the named entry when it is on the page, else the page's main region. */
function focusTarget(entry: string | undefined): HTMLElement | null {
  const named =
    entry === undefined
      ? null
      : document.querySelector(`[${ENTRY_ATTRIBUTE}="${CSS.escape(entry)}"]`);
  return named instanceof HTMLElement ? named : document.querySelector('main');
}

/**
 * Carries out a focus request once the router has shown the page it went
 * back to. Mounted once, in the shell: its effect runs after the page's own
 * elements are in the document.
 */
export function useOpenerFocus(): void {
  const resolved = useRouterState({ select: (s) => s.resolvedLocation?.href });
  useEffect(() => {
    // Nothing has shown yet; a request waits for the page it asks for.
    if (resolved === undefined) {
      return;
    }
    const request = takeOpenerFocus();
    if (request !== undefined) {
      focusTarget(request.entry)?.focus();
    }
  }, [resolved]);
}
