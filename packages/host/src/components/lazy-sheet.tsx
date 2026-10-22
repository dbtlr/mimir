import { useEffect, useState } from 'react';
import type { ComponentType } from 'react';

import { warmable } from '../lib/chunk-warmup';

/**
 * A sheet the shell mounts everywhere but opens rarely, kept out of the
 * console's entry chunk with its module and the form library behind it
 * (MMR-583). It loads when the shell mounts and then mounts closed, so its
 * first open animates like an eagerly loaded sheet's. A failed load leaves
 * the shell standing and retries on the next open.
 */
export function lazySheet<P extends { open: boolean }>(
  load: () => Promise<ComponentType<P>>,
): ComponentType<P> {
  const loadOnce = warmable(load);
  return function LazySheet(props: P) {
    const [Sheet, setSheet] = useState<ComponentType<P>>();
    useEffect(() => {
      if (Sheet !== undefined) {
        return undefined;
      }
      let live = true;
      void (async () => {
        try {
          const loaded = await loadOnce();
          if (live) {
            setSheet(() => loaded);
          }
        } catch {
          // Nothing to show yet; the next open tries again.
        }
      })();
      return () => {
        live = false;
      };
    }, [Sheet, props.open]);
    return Sheet === undefined ? null : <Sheet {...props} />;
  };
}
