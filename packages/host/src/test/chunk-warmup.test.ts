import { describe, expect, vi } from 'vitest';

import { warmChunks, warmable } from '../lib/chunk-warmup';

describe('chunk warm-up (MMR-583)', () => {
  it('loads a chunk once, shared by its use and the warm-up', async () => {
    const load = vi.fn(async () => 'module');
    const loadOnce = warmable(load);
    warmChunks();
    await expect(loadOnce()).resolves.toBe('module');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('retries a chunk whose load failed', async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('module');
    const loadOnce = warmable(load);
    await expect(loadOnce()).rejects.toThrow('offline');
    await expect(loadOnce()).resolves.toBe('module');
  });

  it('leaves a failed warm-up for the chunk use to report', async () => {
    const load = vi.fn(async () => {
      throw new Error('offline');
    });
    warmable(load);
    expect(() => {
      warmChunks();
    }).not.toThrow();
    await vi.waitFor(() => {
      expect(load).toHaveBeenCalled();
    });
  });
});
