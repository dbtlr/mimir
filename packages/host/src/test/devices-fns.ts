// Shared test seam module, not a test body.
// oxlint-disable vitest/require-hook
import { MimirError } from '@mimir/contract';

import {
  approvePairing,
  denyPairing,
  lookupPairing,
  pairedDevices,
  pendingPairings,
  unpairDevice,
} from '../api/fns/devices';
import type { PairedDevice } from '../api/fns/devices';

/*
 * The device pages' server functions served from a small world (MMR-585). A
 * test file that renders them mocks the module first —
 * `vi.mock('../api/fns/devices')` at the top of the file — and then calls
 * `serveDevices`, which answers each function from the world it is given. A
 * case that needs one answer of its own overrides that function after, and
 * asserts the call by function: `expect(approvePairing).toHaveBeenCalledWith({
 * data: { code } })`. See setup.ts for the pattern.
 */

/** A request waiting on the operator, as the waiting list shows it. */
export type WaitingRequest = { device: string; created_at: string; expires_at: string };

/** What a code lookup answers. */
export type FoundRequest = WaitingRequest & { rotates: boolean };

export type DevicesWorld = {
  /** The Waiting card's requests. */
  pending: WaitingRequest[];
  /** The Paired card's devices. */
  paired: PairedDevice[];
  /** Waiting requests by their code (as typed); a code without one matches nothing. */
  codes: Record<string, FoundRequest>;
};

const noMatch = () => new MimirError('not_found', 'No waiting request has this code.');

/** Answer the device pages' server functions from `world`; the returned state is live. */
export function serveDevices(world: Partial<DevicesWorld> = {}): DevicesWorld {
  const state: DevicesWorld = { codes: {}, paired: [], pending: [], ...world };
  vi.mocked(pendingPairings).mockImplementation(async () => state.pending);
  vi.mocked(pairedDevices).mockImplementation(async () => state.paired);
  vi.mocked(lookupPairing).mockImplementation(async ({ data }) => state.codes[data.code] ?? null);
  // A decision consumes its code, as in production: the next lookup finds nothing.
  const consume = (code: string): FoundRequest => {
    const found = state.codes[code];
    if (found === undefined) {
      throw noMatch();
    }
    delete state.codes[code];
    return found;
  };
  vi.mocked(approvePairing).mockImplementation(async ({ data }) => {
    const { device, rotates } = consume(data.code);
    return { device, rotates };
  });
  vi.mocked(denyPairing).mockImplementation(async ({ data }) => ({
    device: consume(data.code).device,
  }));
  vi.mocked(unpairDevice).mockImplementation(async () => ({ requests: 0, tokens: 1 }));
  return state;
}

/** Every device read fails, as when the host cannot be reached. */
export function failDeviceReads(error: Error = new Error('unreachable')): void {
  vi.mocked(pendingPairings).mockRejectedValue(error);
  vi.mocked(pairedDevices).mockRejectedValue(error);
  vi.mocked(lookupPairing).mockRejectedValue(error);
}
