import { useState } from 'react';

/** Where an overlay sends focus when it closes: an element, or a function that finds one. */
export type FinalFocus = HTMLElement | (() => HTMLElement | null);

/**
 * The element that had focus when `open` turned true, as `finalFocus` for an
 * overlay a caller mounts already open and no trigger belongs to. Once that
 * element is gone, or disabled, it finds nothing, which leaves focus where the
 * page's own handoff put it (MMR-474). A `finalFocus` the caller passes wins.
 */
export function useFinalFocus(open: boolean, given: FinalFocus | undefined): FinalFocus {
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  // Read while rendering the opening, before the overlay mounts and moves focus into itself.
  if (open && opener === null && document.activeElement instanceof HTMLElement) {
    setOpener(document.activeElement);
  } else if (!open && opener !== null) {
    setOpener(null);
  }
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
