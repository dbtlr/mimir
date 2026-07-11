import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, vi } from 'vitest';

import { useToastPosition } from '../lib/use-toast-position';

type Listener = () => void;

/**
 * Stub `matchMedia` with a controllable desktop flag. Returns a setter that
 * flips the flag and fires the registered change listeners — a resize across
 * the breakpoint.
 */
function mockViewport(desktop: boolean) {
  const state = { desktop };
  const listeners = new Set<Listener>();
  vi.stubGlobal('matchMedia', (q: string) => ({
    addEventListener: (_: string, fn: Listener) => {
      listeners.add(fn);
    },
    get matches() {
      return state.desktop;
    },
    media: q,
    removeEventListener: (_: string, fn: Listener) => {
      listeners.delete(fn);
    },
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

describe('useToastPosition', () => {
  it('desktop keeps toasts bottom-left, opposite the right-anchored sheet rail', () => {
    mockViewport(true);
    const { result } = renderHook(() => useToastPosition());
    expect(result.current).toBe('bottom-left');
  });

  it('mobile routes toasts top-center — sonner forces full-width bottom below 600px, over the bottom sheet footer', () => {
    mockViewport(false);
    const { result } = renderHook(() => useToastPosition());
    expect(result.current).toBe('top-center');
  });

  it('follows the viewport across the breakpoint', () => {
    const setDesktop = mockViewport(true);
    const { result } = renderHook(() => useToastPosition());
    expect(result.current).toBe('bottom-left');
    act(() => {
      setDesktop(false);
    });
    expect(result.current).toBe('top-center');
    act(() => {
      setDesktop(true);
    });
    expect(result.current).toBe('bottom-left');
  });
});
