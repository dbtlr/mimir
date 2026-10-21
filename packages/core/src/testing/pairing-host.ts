import { healthOf } from '../health';
import { normalizeDeviceName } from '../tokens';
import type { TokenStore } from '../tokens';

const noStore = { 'cache-control': 'no-store' };

/**
 * An in-process host for the pre-credential routes (docs/guides/host.md):
 * `/health` and the two pairing routes over a real {@link TokenStore}, with
 * the host's answers for a bad name (400), a request awaiting collection
 * (409), and an unknown route (400). Tests approve and deny through the
 * store; they wrap the handler to inject faults.
 */
export function pairingHost(
  tokens: TokenStore,
  version: string,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/health') {
      return Response.json(healthOf(version));
    }
    const body: unknown = await request.json().catch(() => null);
    const field = (key: string) =>
      typeof body === 'object' && body !== null && typeof Reflect.get(body, key) === 'string'
        ? String(Reflect.get(body, key))
        : null;
    if (path === '/auth/pairing/requests') {
      const name = field('device');
      const device = name === null ? null : normalizeDeviceName(name);
      if (device === null) {
        return Response.json(
          { error: 'invalid pairing request' },
          { headers: noStore, status: 400 },
        );
      }
      try {
        return Response.json(await tokens.request(device), { headers: noStore });
      } catch {
        return Response.json(
          {
            error: 'this device has an approved pairing request awaiting collection',
            hint: 'deny or unpair the device on the host, or wait for the approval to expire',
          },
          { headers: noStore, status: 409 },
        );
      }
    }
    const secret = field('poll_secret');
    if (path === '/auth/pairing/poll' && secret !== null) {
      return Response.json(await tokens.poll(secret), { headers: noStore });
    }
    return Response.json({ error: 'invalid pairing poll' }, { headers: noStore, status: 400 });
  };
}
