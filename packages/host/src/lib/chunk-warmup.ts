/**
 * Code the console splits out of its entry chunk (MMR-583), warmed once the
 * console is idle so an open tab holds its whole build in memory, as it did
 * when the console was one bundle. A tab left on an old build after another
 * tab applies an update has lost that build's precache, so a chunk it first
 * fetched on demand would 404 instead of loading.
 */
const loaders = new Set<() => Promise<unknown>>();

/**
 * Wraps a dynamic import so it loads once, shared by its use and the warm-up.
 * A failed load is forgotten, so the next call retries it.
 */
export function warmable<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  const attempt = async () => {
    try {
      return await load();
    } catch (error) {
      pending = undefined;
      throw error;
    }
  };
  const loadOnce = () => {
    pending ??= attempt();
    return pending;
  };
  loaders.add(loadOnce);
  return loadOnce;
}

/** Loads every warmable chunk. A failure is left for the chunk's own use to report. */
export function warmChunks(): void {
  for (const load of loaders) {
    void (async () => {
      try {
        await load();
      } catch {
        // The chunk's use retries the load and reports its failure.
      }
    })();
  }
}

/** Warms the chunks once the browser is idle, after the first paint. */
export function warmChunksWhenIdle(): void {
  if ('requestIdleCallback' in globalThis) {
    globalThis.requestIdleCallback(warmChunks);
  } else {
    // Safari has no idle callback; a short delay still clears the first paint.
    globalThis.setTimeout(warmChunks, 1000);
  }
}
