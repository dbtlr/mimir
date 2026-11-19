import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAppBadge } from '../lib/app-badge';
import { applyAppBadge } from '../lib/badge';
import type { BadgeTarget } from '../lib/badge';

function badgeTarget(overrides: Partial<BadgeTarget> = {}) {
  const setAppBadge = vi.fn(async () => {});
  const clearAppBadge = vi.fn(async () => {});
  return { clearAppBadge, setAppBadge, target: { clearAppBadge, setAppBadge, ...overrides } };
}

describe('applyAppBadge', () => {
  it('sets the badge to the count', async () => {
    const { clearAppBadge, setAppBadge, target } = badgeTarget();
    await applyAppBadge(target, 4);
    expect(setAppBadge).toHaveBeenCalledWith(4);
    expect(clearAppBadge).not.toHaveBeenCalled();
  });

  it('clears the badge at zero', async () => {
    const { clearAppBadge, setAppBadge, target } = badgeTarget();
    await applyAppBadge(target, 0);
    expect(clearAppBadge).toHaveBeenCalledOnce();
    expect(setAppBadge).not.toHaveBeenCalled();
  });

  it('does nothing in a browser without the Badging API', async () => {
    await expect(applyAppBadge({}, 2)).resolves.toBeUndefined();
  });

  it('swallows a rejection', async () => {
    const { target } = badgeTarget({ setAppBadge: vi.fn().mockRejectedValue(new Error('denied')) });
    await expect(applyAppBadge(target, 2)).resolves.toBeUndefined();
  });

  it('swallows a synchronous throw', async () => {
    const { target } = badgeTarget({
      setAppBadge: () => {
        throw new Error('nope');
      },
    });
    await expect(applyAppBadge(target, 2)).resolves.toBeUndefined();
  });
});

describe('useAppBadge', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('syncs on each read, including a second read with the same count', () => {
    const { clearAppBadge, setAppBadge, target } = badgeTarget();
    vi.stubGlobal('navigator', target);
    const { rerender } = renderHook(({ read }) => useAppBadge(read), {
      initialProps: { read: undefined as { count: number; readAt: number } | undefined },
    });
    expect(setAppBadge).not.toHaveBeenCalled();
    expect(clearAppBadge).not.toHaveBeenCalled();
    rerender({ read: { count: 2, readAt: 1 } });
    expect(setAppBadge).toHaveBeenCalledWith(2);
    // A push raised the icon meanwhile; the next read of the same count puts it back.
    rerender({ read: { count: 2, readAt: 2 } });
    expect(setAppBadge).toHaveBeenCalledTimes(2);
    rerender({ read: { count: 0, readAt: 3 } });
    expect(clearAppBadge).toHaveBeenCalledOnce();
  });

  it('does not sync again when the same read renders twice', () => {
    const { setAppBadge, target } = badgeTarget();
    vi.stubGlobal('navigator', target);
    const { rerender } = renderHook(({ read }) => useAppBadge(read), {
      initialProps: { read: { count: 2, readAt: 1 } },
    });
    rerender({ read: { count: 2, readAt: 1 } });
    expect(setAppBadge).toHaveBeenCalledOnce();
  });
});
