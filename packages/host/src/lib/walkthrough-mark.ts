import { useRouter, useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';

import { focusMain } from './focus-main';

/*
 * The in-app mark (ADR 0019, MMR-704 refinement: Leaving a walkthrough an
 * entry opened). An entry pushes the walkthrough with a mark in its history
 * entry's state: the path of the page the entry was on, the opener, and the
 * name of the control that takes focus back (MMR-714 refinement). History
 * state survives a reload. A marked walkthrough's Close goes back; the link
 * back goes back when `linkBackAction` says so. Going back leaves a one-time
 * focus request, which the shell carries out once the opener page shows.
 */

const OPENER_KEY = 'walkthroughOpener';
const ENTRY_KEY = 'walkthroughEntry';

/**
 * The attribute that names a control focus returns to after a walkthrough:
 * an entry on a page, or the Needs you alert for the entries in its popover.
 */
export const RETURN_TARGET_ATTRIBUTE = 'data-walkthrough-return';

/** The name every entry in the Needs you popover records: the alert takes focus back, as the popover is closed. */
export const NEEDS_YOU_ENTRY = 'needs-you';

/**
 * Where a walkthrough was opened: the opener's path, and the name of the
 * control that takes focus back. A mark written before MMR-714 names none.
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
 * asks for shows. One console runs one router, so there is one request at most.
 */
let pendingFocus: { entry: string | undefined } | undefined;

/** The current history entry's mark, if the walkthrough was opened in-app. */
export function useOpenerMark(): Mark | undefined {
  return useRouterState({ select: (s) => readMark(s.location.state) });
}

/** The path of the page an entry is on: the opener it records. */
export function useOpenerPath(): string {
  return useRouterState({ select: (s) => s.location.pathname });
}

/** Go back one history entry to the opener, asking it to focus the control the mark names. */
export function useBackToOpener(): (mark: Mark) => void {
  const router = useRouter();
  return (mark) => {
    pendingFocus = { entry: mark.entry };
    router.history.back();
  };
}

/** Focus the control named `entry` when it is on the page, else the page's main region. */
function focusReturnTarget(entry: string | undefined): void {
  const named =
    entry === undefined
      ? null
      : document.querySelector(`[${RETURN_TARGET_ATTRIBUTE}="${CSS.escape(entry)}"]`);
  if (named instanceof HTMLElement) {
    named.focus();
  } else {
    focusMain();
  }
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
    const request = pendingFocus;
    pendingFocus = undefined;
    if (request !== undefined) {
      focusReturnTarget(request.entry);
    }
  }, [resolved]);
}
