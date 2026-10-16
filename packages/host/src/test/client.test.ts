import { afterEach, describe, expect, vi } from 'vitest';

import { apiGet, apiSend } from '../api/client';
import { ApiError, isNotFound } from '../api/errors';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('apiGet', () => {
  it('throws an ApiError carrying the HTTP status on a non-2xx answer', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('gone', { status: 404 }));
    const failing = apiGet('/api/projects/SR');
    await expect(failing).rejects.toBeInstanceOf(ApiError);
    await expect(failing).rejects.toMatchObject({ status: 404 });
  });
});

describe('isNotFound', () => {
  it('is true only for a server-answered 404', () => {
    expect(isNotFound(new ApiError('GET /api/projects/SR → 404', 404))).toBe(true);
    expect(isNotFound(new ApiError('boom', 500))).toBe(false);
  });

  it('is false for network-shaped failures — unreachable is not not-found', () => {
    expect(isNotFound(new TypeError('fetch failed'))).toBe(false);
    expect(isNotFound(undefined)).toBe(false);
  });
});

describe('apiSend', () => {
  it('pOSTs JSON and returns the parsed body', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ id: 'MMR-9' }, { status: 200 }));
    const out = await apiSend<{ id: string }>('POST', '/api/nodes/MMR-9/start');
    expect(out).toStrictEqual({ id: 'MMR-9' });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
  });

  it('sends a JSON body when given one', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await apiSend('POST', '/api/nodes/MMR-9/park', { reason: 'waiting' });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.body).toBe(JSON.stringify({ reason: 'waiting' }));
  });

  it("throws the error envelope's message on failure", async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ error: { code: 'validation', message: 'already done' } }, { status: 400 }),
    );
    await expect(apiSend('POST', '/api/nodes/MMR-9/done')).rejects.toThrow('already done');
  });
});
