// Shared test seam module, not a test body.
// oxlint-disable vitest/require-hook
import { connectT3, launchT3, t3Catalog, t3Origin, t3Status } from '../api/fns/t3';
import type { T3Catalog, T3ConnectResult, T3LaunchResult, T3Status } from '../api/fns/t3';

/*
 * The T3 server functions served from one state (ADR 0040). A test file that
 * renders the Devices page mocks the module first — `vi.mock('../api/fns/t3')`
 * — then calls `serveT3`. Connect answers `connect`, by default an
 * authorization URL.
 */

export const T3_AUTHORIZE_URL = 'https://t3.example/oauth/mcp/authorize?state=s';

export function serveT3(
  status: T3Status = { state: 'unconfigured' },
  connect: T3ConnectResult = { state: 'authorize', url: T3_AUTHORIZE_URL },
): void {
  vi.mocked(t3Status).mockResolvedValue(status);
  vi.mocked(connectT3).mockResolvedValue(connect);
}

export const T3_ORIGIN = 'https://t3.example';

/**
 * The launch side served from one state: the Open in T3 origin (null when the
 * feature is unconfigured), one project's catalog, and a launch answer.
 */
export function serveT3Launch(
  catalog: T3Catalog,
  launch: T3LaunchResult = {
    environmentId: 'env-1',
    label: 'Valhalla',
    state: 'launched',
    threadId: 'thread-1',
  },
  origin: string | null = T3_ORIGIN,
): void {
  vi.mocked(t3Origin).mockResolvedValue({ origin });
  vi.mocked(t3Catalog).mockResolvedValue(catalog);
  vi.mocked(launchT3).mockResolvedValue(launch);
}
