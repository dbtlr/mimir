import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { syncAppBadge, useAppBadge } from '../lib/app-badge';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubBadge(overrides: Record<string, unknown> = {}) {
  const setAppBadge = vi.fn(async () => {});
  const clearAppBadge = vi.fn(async () => {});
  vi.stubGlobal('navigator', { clearAppBadge, setAppBadge, ...overrides });
  return { clearAppBadge, setAppBadge };
}

describe('syncAppBadge', () => {
  it('sets the badge to the count', async () => {
    const { clearAppBadge, setAppBadge } = stubBadge();
    await syncAppBadge(4);
    expect(setAppBadge).toHaveBeenCalledWith(4);
    expect(clearAppBadge).not.toHaveBeenCalled();
  });

  it('clears the badge at zero', async () => {
    const { clearAppBadge, setAppBadge } = stubBadge();
    await syncAppBadge(0);
    expect(clearAppBadge).toHaveBeenCalledOnce();
    expect(setAppBadge).not.toHaveBeenCalled();
  });

  it('does nothing in a browser without the Badging API', async () => {
    vi.stubGlobal('navigator', {});
    await expect(syncAppBadge(2)).resolves.toBeUndefined();
  });

  it('swallows a rejection', async () => {
    stubBadge({ setAppBadge: vi.fn().mockRejectedValue(new Error('denied')) });
    await expect(syncAppBadge(2)).resolves.toBeUndefined();
  });

  it('swallows a synchronous throw', async () => {
    stubBadge({
      setAppBadge: () => {
        throw new Error('nope');
      },
    });
    await expect(syncAppBadge(2)).resolves.toBeUndefined();
  });
});

describe('useAppBadge', () => {
  it('syncs when the count is known and again when it changes', () => {
    const { clearAppBadge, setAppBadge } = stubBadge();
    const { rerender } = renderHook(({ count }) => useAppBadge(count), {
      initialProps: { count: undefined as number | undefined },
    });
    expect(setAppBadge).not.toHaveBeenCalled();
    expect(clearAppBadge).not.toHaveBeenCalled();
    rerender({ count: 2 });
    expect(setAppBadge).toHaveBeenCalledWith(2);
    rerender({ count: 0 });
    expect(clearAppBadge).toHaveBeenCalledOnce();
  });
});
