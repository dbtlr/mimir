import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/errors';
import type { fetchHealth as FetchHealth } from '../api/health';

// The suite mocks the health module for every page; this file wants the real one.
const { fetchHealth } = await vi.importActual<{ fetchHealth: typeof FetchHealth }>('../api/health');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchHealth', () => {
  it('reads the host build and schema from /health', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        Response.json({ minClient: '0.26.0-next', schema: 6, status: 'ok', version: '0.26.0' }),
      );
    await expect(fetchHealth()).resolves.toEqual({
      minClient: '0.26.0-next',
      schema: 6,
      status: 'ok',
      version: '0.26.0',
    });
    expect(spy).toHaveBeenCalledWith('/health', expect.anything());
  });

  it('throws an ApiError carrying the HTTP status on a non-2xx answer', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('down', { status: 503 }));
    const failing = fetchHealth();
    await expect(failing).rejects.toBeInstanceOf(ApiError);
    await expect(failing).rejects.toMatchObject({ status: 503 });
  });
});
