/**
 * The one fetch seam. Every request is same-origin: production serves the SPA
 * from `mimir serve` itself, and `vite dev` proxies `/api` to it (MMR-426).
 */
import { ApiError } from './errors';

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new ApiError(`GET ${path} → ${String(res.status)}`, res.status);
  }
  // Untrusted HTTP boundary: the response is typed as the caller's `T`. Per-response
  // schema validation (parseJson(text, schema)) is the planned follow-up — it needs
  // Standard Schemas for the wire types threaded through every query/mutation.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (await res.json()) as T;
}

type WriteMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * The write seam — mirrors {@link apiGet} for mutations. Sends JSON, and on a
 * non-2xx surfaces the resource envelope's `error.message` (ADR 0012) so the
 * caller can toast the real reason rather than a bare status code.
 */
export async function apiSend<T>(method: WriteMethod, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    method,
  });
  if (!res.ok) {
    let message = `${method} ${path} → ${String(res.status)}`;
    try {
      // Untrusted error envelope — see the apiGet note (schema validation is the follow-up).
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const data = (await res.json()) as { error?: { message?: string } };
      if (data.error?.message != null && data.error.message !== '') {
        message = data.error.message;
      }
    } catch {
      // non-JSON error body — keep the status-code message
    }
    throw new ApiError(message, res.status);
  }
  // Untrusted HTTP boundary — see the apiGet note (schema validation is the follow-up).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (await res.json()) as T;
}
