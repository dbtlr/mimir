import { useSyncExternalStore } from 'react';

/**
 * Whether a CSS media query matches, live across resizes. For the few places
 * that must mount one surface or another (a popover on a desktop, a bottom
 * sheet on a phone) rather than hide one with a breakpoint class, which would
 * mount both and duplicate their controls.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = globalThis.matchMedia(query);
      list.addEventListener('change', notify);
      return () => {
        list.removeEventListener('change', notify);
      };
    },
    () => globalThis.matchMedia(query).matches,
  );
}
