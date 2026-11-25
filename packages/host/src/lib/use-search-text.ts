import { useEffect, useEffectEvent, useState } from 'react';

/** How long typing pauses before the search reaches the URL: one read per pause, not per key. */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * A list's search box, controlled and debounced (the MMR-63 pattern): the box
 * updates at once, and `push` writes the text to the URL once typing pauses.
 * A change to the URL's `q` from outside (Back, a cleared chip) re-syncs the
 * box during render.
 */
export function useSearchText(
  urlQ: string | undefined,
  push: (value: string) => void,
): [string, (value: string) => void] {
  const [q, setQ] = useState(urlQ ?? '');
  const [syncedQ, setSyncedQ] = useState(urlQ);
  if (urlQ !== syncedQ) {
    setSyncedQ(urlQ);
    setQ(urlQ ?? '');
  }
  const pushQ = useEffectEvent((value: string) => {
    push(value);
  });
  useEffect(() => {
    if (q === (urlQ ?? '')) {
      return undefined;
    }
    const t = setTimeout(() => {
      pushQ(q);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
    };
  }, [q, urlQ]);
  return [q, setQ];
}
