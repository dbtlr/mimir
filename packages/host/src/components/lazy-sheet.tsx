import { Suspense, lazy, useState } from 'react';
import type { ComponentType } from 'react';

import { warmable } from '../lib/chunk-warmup';

/**
 * A sheet the shell mounts everywhere but opens rarely, kept out of the
 * console's entry chunk with its module and the form library behind it
 * (MMR-583). The idle warm-up loads it early, and it mounts when it first
 * opens. It then stays mounted, so later opens are instant and every close
 * animates as an eagerly loaded sheet would.
 */
export function lazySheet<P extends { open: boolean }>(
  load: () => Promise<ComponentType<P>>,
): ComponentType<P> {
  const loadOnce = warmable(load);
  const Sheet = lazy(async () => ({ default: await loadOnce() }));
  return function LazySheet(props: P) {
    const [opened, setOpened] = useState(props.open);
    if (props.open && !opened) {
      setOpened(true);
    }
    return opened ? (
      <Suspense fallback={null}>
        <Sheet {...props} />
      </Suspense>
    ) : null;
  };
}
