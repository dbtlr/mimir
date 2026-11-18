import { useRouter, useRouterState } from '@tanstack/react-router';

/*
 * The in-app mark (ADR 0019, MMR-704 refinement: Leaving a walkthrough an
 * entry opened). An entry pushes the walkthrough with a mark in its history
 * entry's state: the path of the page the entry was on, the opener. History
 * state survives a reload. Pure helpers decide where Close and the link back
 * go; the hooks read the mark from the router and act on those decisions.
 */

const MARK_KEY = 'walkthroughOpener';

/** The history state of an entry that opens a walkthrough from `openerPath`. */
export function markState(openerPath: string | undefined): Record<string, string> | undefined {
  return openerPath === undefined ? undefined : { [MARK_KEY]: openerPath };
}

/** The opener recorded in a history entry's state, or undefined when it is unmarked. */
export function readMark(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null) {
    return undefined;
  }
  const value: unknown = Reflect.get(state, MARK_KEY);
  return typeof value === 'string' ? value : undefined;
}

/** Close on a marked walkthrough goes back one history entry; unmarked, it replaces the entry. */
export function closeAction(opener: string | undefined): 'back' | 'replace' {
  return opener === undefined ? 'replace' : 'back';
}

/**
 * The link back to the page goes back when the walkthrough was opened from
 * that very page, so history holds no second copy of it; otherwise it replaces.
 */
export function linkBackAction(opener: string | undefined, pagePath: string): 'back' | 'replace' {
  return opener === pagePath ? 'back' : 'replace';
}

/** The current history entry's opener mark, if the walkthrough was opened in-app. */
export function useOpenerMark(): string | undefined {
  return useRouterState({ select: (s) => readMark(s.location.state) });
}

/** The path of the page an entry is on: the opener it records. */
export function useOpenerPath(): string {
  return useRouterState({ select: (s) => s.location.pathname });
}

/** Go back one history entry. */
export function useHistoryBack(): () => void {
  const router = useRouter();
  return () => {
    router.history.back();
  };
}
