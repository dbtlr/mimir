import { BUILD_VERSION } from '../lib/build-version';
import { hostConfig } from './config';
import { openHost } from './host';

declare global {
  // Nitro plugins and Start server routes are separate bundles in one process.
  // Their store and shutdown hook must share one lifetime across both bundles.
  var mimirHostRuntime: ReturnType<typeof openHost> | undefined;
}

/** Development defaults to a disposable store; the image names its /data volume. */
export function hostRuntime() {
  globalThis.mimirHostRuntime ??= openRuntime();
  return globalThis.mimirHostRuntime;
}

export async function handleTrpc(request: Request) {
  return (await hostRuntime()).handleTrpc(request);
}

export async function handlePairingRequest(request: Request) {
  return (await hostRuntime()).handlePairingRequest(request);
}

export async function handlePairingPoll(request: Request) {
  return (await hostRuntime()).handlePairingPoll(request);
}

export async function closeHost() {
  await (await globalThis.mimirHostRuntime)?.close();
  globalThis.mimirHostRuntime = undefined;
}

async function openRuntime() {
  return openHost(await hostConfig(), BUILD_VERSION);
}
