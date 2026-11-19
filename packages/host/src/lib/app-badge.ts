import { useEffect } from 'react';

/** The Badging API, which not every browser has; lib.dom does not type it everywhere. */
type BadgeNavigator = {
  clearAppBadge?: () => Promise<void>;
  setAppBadge?: (count?: number) => Promise<void>;
};

/**
 * Show `count` on the installed app's icon, clearing it at zero. A browser
 * without the Badging API, or one that refuses, is not an error: the badge is
 * a courtesy, so this never throws.
 */
export async function syncAppBadge(count: number): Promise<void> {
  const target: BadgeNavigator = navigator;
  try {
    if (count === 0) {
      await target.clearAppBadge?.();
    } else {
      await target.setAppBadge?.(count);
    }
  } catch {
    // unsupported or refused: nothing to do
  }
}

/** Keep the app icon badge at the needs-you count; `undefined` (not yet read) leaves it alone. */
export function useAppBadge(count: number | undefined): void {
  useEffect(() => {
    if (count !== undefined) {
      void syncAppBadge(count);
    }
  }, [count]);
}
