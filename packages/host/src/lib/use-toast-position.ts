import { useEffect, useState } from 'react';
import type { ToasterProps } from 'sonner';

/**
 * Below Tailwind's `sm` breakpoint (640px) the Sheet renders as a full-width
 * bottom sheet, and sonner's own ≤600px stylesheet forces the toaster to
 * `width:100%` at the bottom regardless of the `position` prop's x-axis — so
 * any bottom-anchored toast lands directly over the sheet footer (the
 * create/retry-deps buttons) and, at sonner's very high z-index, intercepts
 * taps on them. Small viewports therefore route toasts to the top; desktop
 * keeps bottom-left, opposite the right-anchored sheet rail.
 */
const DESKTOP_QUERY = '(min-width: 640px)';

export type ToastPosition = Extract<ToasterProps['position'], 'bottom-left' | 'top-center'>;

/** The viewport-appropriate Toaster position, live across resizes. */
export function useToastPosition(): ToastPosition {
  const [desktop, setDesktop] = useState(() => globalThis.matchMedia(DESKTOP_QUERY).matches);

  useEffect(() => {
    const mq = globalThis.matchMedia(DESKTOP_QUERY);
    const onChange = () => {
      setDesktop(mq.matches);
    };
    // reconcile in case the viewport changed between first render and mount
    onChange();
    mq.addEventListener('change', onChange);
    return () => {
      mq.removeEventListener('change', onChange);
    };
  }, []);

  return desktop ? 'bottom-left' : 'top-center';
}
