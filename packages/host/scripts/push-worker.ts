import { resolve } from 'node:path';

import { build } from 'vite';

/** Where the push worker's entry sits, and where its build lands, under the host root. */
const ENTRY = 'src/sw/push-entry.ts';
const OUT_DIR = '.output/public';

/**
 * Compile the service worker's push handlers (MMR-710) to one classic script
 * in the public output, for the generated worker to import, and return its
 * file name. The name carries a content hash: the browser fetches an imported
 * script through its HTTP cache, so a fixed name would let a new worker import
 * the old handlers after a deploy. Paths resolve against `root`, the host
 * package, never the process's working directory.
 */
export async function buildPushWorker({ root }: { root: string }): Promise<string> {
  const result = await build({
    build: {
      emptyOutDir: false,
      lib: {
        entry: resolve(root, ENTRY),
        fileName: () => 'sw-push-[hash].js',
        formats: ['iife'],
        name: 'MimirPushWorker',
      },
      outDir: resolve(root, OUT_DIR),
      sourcemap: false,
    },
    configFile: false,
    logLevel: 'warn',
    publicDir: false,
    root,
  });
  const outputs = Array.isArray(result) ? result : [result];
  const names = outputs.flatMap((output) =>
    'output' in output
      ? output.output.filter((file) => file.type === 'chunk').map((file) => file.fileName)
      : [],
  );
  const [name, ...rest] = names;
  if (name === undefined || rest.length > 0) {
    throw new Error(`the push worker build must emit one script, not ${String(names.length)}`);
  }
  return name;
}
