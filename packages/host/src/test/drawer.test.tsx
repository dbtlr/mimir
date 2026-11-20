import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDrawerSide } from '../components/ui/drawer';

type Listener = () => void;

/** Stub `matchMedia` with a controllable desktop flag; the setter fires change listeners. */
function mockViewport(desktop: boolean) {
  const state = { desktop };
  const listeners = new Set<Listener>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    addEventListener: (_: string, fn: Listener) => listeners.add(fn),
    get matches() {
      return state.desktop;
    },
    media: query,
    removeEventListener: (_: string, fn: Listener) => listeners.delete(fn),
  }));
  return (next: boolean) => {
    state.desktop = next;
    for (const fn of listeners) {
      fn();
    }
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useDrawerSide', () => {
  it('opens from the bottom on a phone', () => {
    mockViewport(false);
    expect(renderHook(() => useDrawerSide()).result.current).toBe('bottom');
  });

  it('opens from the right from md up, and follows a resize across the breakpoint', () => {
    const setDesktop = mockViewport(false);
    const { result } = renderHook(() => useDrawerSide());
    act(() => setDesktop(true));
    expect(result.current).toBe('right');
  });
});
