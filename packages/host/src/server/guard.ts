import type { HostGuard } from '@mimir/api';

/**
 * Answer every request through the host guard first: Host filtering and the
 * cross-origin write check cover public files, `/api`, `/trpc`, and server
 * functions alike, before Start dispatches. Start's CSRF middleware
 * (src/start.ts) checks server functions again once they reach Start.
 */
export function guardEveryRoute<Args extends [Request, ...unknown[]]>(
  fetch: (...args: Args) => Response | Promise<Response>,
  ready: Promise<HostGuard>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    const guard = await ready;
    return guard(args[0]) ?? fetch(...args);
  };
}
