import { MimirError, normalizeDeviceName } from '@mimir/core';
import type { BuiltStore } from '@mimir/core';

const WINDOW_MS = 10 * 60 * 1000;
const REQUEST_LIMIT = 10;

const noStore = { 'cache-control': 'no-store' };

/**
 * The pairing host routes, outside the Engine and its version/bearer checks:
 * a client files a request, the operator approves its code on the host, and
 * the client polls with its secret until it collects the device token.
 */
export function createPairingHandlers({
  tokens,
  log = (line) => console.error(line),
  clock = Date.now,
}: Pick<BuiltStore, 'tokens'> & { log?: (line: string) => void; clock?: () => number }) {
  let admitted: number[] = [];
  // Host-wide, in memory: client addresses are not trustworthy behind Caddy and the tailnet.
  const limited = () => {
    const at = clock();
    admitted = admitted.filter((time) => time > at - WINDOW_MS);
    const oldest = admitted[0];
    return admitted.length >= REQUEST_LIMIT && oldest !== undefined
      ? Response.json(
          { error: 'too many pairing requests' },
          {
            headers: {
              ...noStore,
              'retry-after': String(Math.ceil((oldest + WINDOW_MS - at) / 1000)),
            },
            status: 429,
          },
        )
      : null;
  };
  const event = (name: string, fields: Record<string, string> = {}) =>
    log(JSON.stringify({ event: name, ...fields, time: new Date(clock()).toISOString() }));
  // Driver errors may embed credential input; log only the fault event and time.
  const fault = (name: string) => {
    event(name);
    return Response.json(
      { error: 'the request did not complete' },
      { headers: noStore, status: 500 },
    );
  };
  return {
    poll: async (request: Request) => {
      const secret = stringField(await request.json().catch(() => null), 'poll_secret');
      if (secret === null) {
        return Response.json({ error: 'invalid pairing poll' }, { headers: noStore, status: 400 });
      }
      try {
        const answer = await tokens.poll(secret);
        if (answer.status === 'approved') {
          event('pairing_completed', { device: answer.device });
        }
        return Response.json(answer, { headers: noStore });
      } catch {
        return fault('pairing_poll_fault');
      }
    },
    request: async (request: Request) => {
      const refusal = limited();
      if (refusal) {
        return refusal;
      }
      const name = stringField(await request.json().catch(() => null), 'device');
      const device = name === null ? null : normalizeDeviceName(name);
      if (device === null) {
        return Response.json(
          { error: 'invalid pairing request' },
          { headers: noStore, status: 400 },
        );
      }
      // Recheck and reserve synchronously, so concurrent creations cannot pass the limit.
      const blocked = limited();
      if (blocked) {
        return blocked;
      }
      const at = clock();
      admitted.push(at);
      try {
        const created = await tokens.request(device);
        event('pairing_requested', { device });
        return Response.json(created, { headers: noStore });
      } catch (error) {
        // A refusal or a store fault created nothing, so it releases its reservation.
        const reservation = admitted.indexOf(at);
        if (reservation !== -1) {
          admitted.splice(reservation, 1);
        }
        if (error instanceof MimirError && error.code === 'conflict') {
          return Response.json(
            {
              error: 'this device has an approved pairing request awaiting collection',
              hint: 'deny or unpair the device on the host, or wait for the approval to expire',
            },
            { headers: noStore, status: 409 },
          );
        }
        return fault('pairing_request_fault');
      }
    },
  };
}

function stringField(input: unknown, key: string): string | null {
  if (typeof input !== 'object' || input === null || !(key in input)) {
    return null;
  }
  const value: unknown = Reflect.get(input, key);
  return typeof value === 'string' ? value : null;
}

/** Pairing routes accept only POST. */
export function postOnly() {
  return Response.json(
    { error: 'method not allowed' },
    { headers: { ...noStore, allow: 'POST' }, status: 405 },
  );
}

/** Unknown `/auth` paths get a refusal a client can read, not the console's HTML shell with a 200. */
export function unknownAuthResponse() {
  return Response.json(
    {
      error: {
        code: 'not_found',
        hint: 'pair through POST /auth/pairing/requests and POST /auth/pairing/poll',
        message: 'the host has no such /auth route',
      },
    },
    { headers: noStore, status: 404 },
  );
}
