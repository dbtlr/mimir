// Shared test helper module, not a test body.
import { act } from '@testing-library/react';
import { vi } from 'vitest';

/** A named viewport: a desktop, a tablet (between `md` and `lg`), or a phone. */
export type Viewport = 'desktop' | 'tablet' | 'phone';

const WIDTH: Record<Viewport, number> = { desktop: 1280, phone: 390, tablet: 900 };

/** Whether a `(min-width: Npx)` query holds at `width`; any other query does not. */
function matchesWidth(query: string, width: number): boolean {
  const min = /\(min-width:\s*(\d+)px\)/.exec(query)?.[1];
  return min !== undefined && width >= Number(min);
}

/**
 * Pin the viewport the shell switches on, by width: `(min-width: Npx)` queries
 * match when the viewport is at least N wide. The returned setter flips it and
 * notifies the listeners, as a window resize does. Callers restore the real
 * `matchMedia` with `vi.unstubAllGlobals()`.
 */
export function stubViewport(initial: Viewport) {
  let width = WIDTH[initial];
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    get matches() {
      return matchesWidth(query, width);
    },
    media: query,
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  }));
  return (next: Viewport) => {
    width = WIDTH[next];
    act(() => {
      for (const listener of listeners) {
        listener();
      }
    });
  };
}
