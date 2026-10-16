import { resolve } from 'node:path';

import { BUILD_VERSION } from '../lib/build-version';
import { openHost } from './host';

declare global {
  // Nitro plugins and Start server routes are separate bundles in one process.
  // Their store and shutdown hook must share one lifetime across both bundles.
  var mimirHostRuntime: ReturnType<typeof openHost> | undefined;
}

/** Development defaults to a disposable store; the image names its /data volume. */
export function hostRuntime() {
  globalThis.mimirHostRuntime ??= openHost(
    process.env.MIMIR_DATA_DIR ?? resolve('.dev/host'),
    BUILD_VERSION,
  );
  return globalThis.mimirHostRuntime;
}

export async function handleApi(request: Request) {
  return (await hostRuntime()).handle(request);
}

export async function closeHost() {
  await (await globalThis.mimirHostRuntime)?.close();
  globalThis.mimirHostRuntime = undefined;
}
