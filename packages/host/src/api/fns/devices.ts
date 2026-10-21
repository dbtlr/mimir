import { createServerFn } from '@tanstack/react-start';

import { createDeviceHandlers, parseCodeInput, parseDeviceInput } from '../../server/devices';
import type { CodeInput, DeviceInput } from '../../server/devices';
import { deviceTokens } from './engine';

export type { PairedDevice } from '../../server/devices';

/*
 * The device pages' server functions (MMR-585): pairing and unpairing from the
 * console (ADR 0038). They act on the host's token
 * store, not the Engine; each body is a handler in server/devices.ts. Reads are
 * GETs and writes are POSTs. The query policy lives in device-queries.ts and
 * device-mutations.ts.
 */

const handlers = async () => createDeviceHandlers(await deviceTokens());

/** Live requests awaiting a decision; codes are hashed, so they never appear. */
export const pendingPairings = createServerFn({ method: 'GET' }).handler(async () =>
  (await handlers()).pendingPairings(),
);

/** The active paired devices: name, paired instant, last use. */
export const pairedDevices = createServerFn({ method: 'GET' }).handler(async () =>
  (await handlers()).pairedDevices(),
);

/** The waiting request a code names, or null when none waits on it. */
export const lookupPairing = createServerFn({ method: 'GET' })
  .validator((input: CodeInput) => parseCodeInput(input))
  .handler(async ({ data }) => (await handlers()).lookupPairing(data.code));

/** Approve the waiting request a code names. */
export const approvePairing = createServerFn({ method: 'POST' })
  .validator((input: CodeInput) => parseCodeInput(input))
  .handler(async ({ data }) => (await handlers()).approvePairing(data.code));

/** Deny the waiting request a code names. */
export const denyPairing = createServerFn({ method: 'POST' })
  .validator((input: CodeInput) => parseCodeInput(input))
  .handler(async ({ data }) => (await handlers()).denyPairing(data.code));

/** Unpair a device: its token stops working at once. */
export const unpairDevice = createServerFn({ method: 'POST' })
  .validator((input: DeviceInput) => parseDeviceInput(input))
  .handler(async ({ data }) => (await handlers()).unpairDevice(data.device));
