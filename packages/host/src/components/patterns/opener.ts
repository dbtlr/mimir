import { useState } from 'react';

/** Where an overlay sends focus when it closes: an element, or a function that finds one. */
export type FinalFocus = HTMLElement | (() => HTMLElement | null);

/**
 * The element that had focus when `open` last turned true, as `finalFocus` for
 * an overlay a caller mounts already open and no trigger belongs to, or one
 * that several controls open. Once that element is gone, or disabled, it finds
 * nothing, which leaves focus where the page's own handoff put it (MMR-474). A
 * `finalFocus` the caller passes wins.
 */
export function useFinalFocus(open: boolean, given: FinalFocus | undefined): FinalFocus {
  const [seen, setSeen] = useState<{ open: boolean; opener: HTMLElement | null }>({
    open: false,
    opener: null,
  });
  // Read while rendering each opening, before the overlay mounts and moves focus into itself. The
  // opener stays through the close, since the overlay asks for it after `open` turns false.
  if (open !== seen.open) {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSeen({ open, opener: open ? active : seen.opener });
  }
  const { opener } = seen;
  if (given !== undefined) {
    return given;
  }
  return () => {
    const usable =
      opener !== null &&
      opener !== document.body &&
      opener.isConnected &&
      !(opener instanceof HTMLButtonElement && opener.disabled);
    return usable ? opener : null;
  };
}
