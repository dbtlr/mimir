// The contract, not core: the console's server-function module loads this file too, and core
// holds the store drivers a browser-side test environment cannot bundle.
import { MimirError, parseEngineInput } from '@mimir/contract';
import type { TokenStore } from '@mimir/core';
import { z } from 'zod';

/**
 * The token-store methods the console's device pages use. The server functions
 * in api/fns/devices.ts hand these to {@link createDeviceHandlers}, so the
 * logic runs, and is tested, without the Start runtime.
 */
export type DeviceTokens = Pick<
  TokenStore,
  'approve' | 'deny' | 'list' | 'listPending' | 'lookup' | 'revoke'
>;

/** A paired device as the console lists it: never its token or hash. */
export type PairedDevice = { device: string; created_at: string; last_used_at: string | null };

const NO_WAITING_REQUEST = 'No waiting request has this code.';

// One answer for a wrong, used, expired, or malformed code, so the page can't tell them apart.
function decided<T>(result: T | null): T {
  if (result === null) {
    throw new MimirError('not_found', NO_WAITING_REQUEST);
  }
  return result;
}

/** The console's side of pairing: list, check, decide, and unpair, over the host's token store. */
export function createDeviceHandlers(tokens: DeviceTokens) {
  return {
    approvePairing: async (code: string) => decided(await tokens.approve(code)),
    denyPairing: async (code: string) => decided(await tokens.deny(code)),
    lookupPairing: (code: string) => tokens.lookup(code),
    pairedDevices: async (): Promise<PairedDevice[]> =>
      (await tokens.list()).map(({ device, created_at, last_used_at }) => ({
        created_at,
        device,
        last_used_at,
      })),
    pendingPairings: () => tokens.listPending(),
    unpairDevice: (device: string) => tokens.revoke(device),
  };
}

const codeSchema = z.strictObject({ code: z.string().min(1) });
const deviceSchema = z.strictObject({ device: z.string().min(1) });

/** What the lookup, approve, and deny functions take. */
export type CodeInput = z.output<typeof codeSchema>;
export const parseCodeInput = (input: unknown): CodeInput => parseEngineInput(codeSchema, input);

/** What the unpair function takes. */
export type DeviceInput = z.output<typeof deviceSchema>;
export const parseDeviceInput = (input: unknown): DeviceInput =>
  parseEngineInput(deviceSchema, input);
