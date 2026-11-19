/*
 * The app icon badge (MMR-710), shared by the console and the service worker.
 * It imports nothing, so the worker bundle stays free of React.
 */

/** The Badging API on a window's or a worker's navigator, which not every browser has. */
export type BadgeTarget = {
  clearAppBadge?: () => Promise<void>;
  setAppBadge?: (count?: number) => Promise<void>;
};

/**
 * Show `count` on the installed app's icon, clearing it at zero. A browser
 * without the Badging API, or one that refuses, is not an error: the badge is
 * a courtesy, so this never throws.
 */
export async function applyAppBadge(target: BadgeTarget, count: number): Promise<void> {
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
