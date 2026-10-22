import { useEffect, useEffectEvent, useState } from 'react';
import type { ComponentType } from 'react';
import { toast } from 'sonner';

import { warmable } from '../lib/chunk-warmup';

/**
 * A sheet the shell mounts everywhere but opens rarely, kept out of the
 * console's entry chunk with its module and the form library behind it
 * (MMR-583). It loads when the shell mounts and then mounts closed, so its
 * first open animates like an eagerly loaded sheet's. A failed load leaves
 * the shell standing: an open sheet says so, reports itself closed, and the
 * next open retries the load. It never reloads the tab on its own, since a
 * click would then discard unsaved input elsewhere on the page.
 */
export function lazySheet<P extends { open: boolean; onOpenChange: (open: boolean) => void }>(
  load: () => Promise<ComponentType<P>>,
): ComponentType<P> {
  const loadOnce = warmable(load);
  return function LazySheet(props: P) {
    const [Sheet, setSheet] = useState<ComponentType<P>>();
    const closeAfterFailedLoad = useEffectEvent(() => {
      if (props.open) {
        props.onOpenChange(false);
        toast.error("Couldn't open this — refresh the tab and try again.");
      }
    });
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
          if (live) {
            closeAfterFailedLoad();
          }
        }
      })();
      return () => {
        live = false;
      };
    }, [Sheet, props.open]);
    return Sheet === undefined ? null : <Sheet {...props} />;
  };
}
