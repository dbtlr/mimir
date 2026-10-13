// Shared test helper module, not a test body.
import { act } from '@testing-library/react';
import { vi } from 'vitest';

/**
 * Pin the viewport the shell switches on: a desktop width, or a phone's. The
 * returned setter flips it and notifies the listeners, as a window resize does.
 * Callers restore the real `matchMedia` with `vi.unstubAllGlobals()`.
 */
export function stubViewport(initial: 'desktop' | 'phone') {
  let desktop = initial === 'desktop';
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    get matches() {
      return desktop;
    },
    media: query,
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  }));
  return (next: 'desktop' | 'phone') => {
    desktop = next === 'desktop';
    act(() => {
      for (const listener of listeners) {
        listener();
      }
    });
  };
}
