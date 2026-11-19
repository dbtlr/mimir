import { useEffect } from 'react';

import { applyAppBadge } from './badge';

/** One successful read of the needs-you count; `readAt` tells two reads of one count apart. */
export type BadgeRead = { count: number; readAt: number };

/**
 * Keep the app icon badge at the needs-you count. Each new read syncs it, even
 * at an unchanged count, because a push may have moved the icon in between;
 * `undefined` (no read yet) leaves the icon alone.
 */
export function useAppBadge(read: BadgeRead | undefined): void {
  const count = read?.count;
  const readAt = read?.readAt;
  useEffect(() => {
    if (count !== undefined && readAt !== undefined) {
      void applyAppBadge(navigator, count);
    }
  }, [count, readAt]);
}
