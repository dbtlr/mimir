import type { BuiltStore } from '@mimir/core';

const WINDOW_MS = 10 * 60 * 1000;
const FAILURE_LIMIT = 5;

/** Redeem host credentials outside the Engine and its version/bearer checks. */
export function createPairingHandler({
  tokens,
  log = (line) => console.error(line),
  clock = Date.now,
}: Pick<BuiltStore, 'tokens'> & { log?: (line: string) => void; clock?: () => number }) {
  let failures: number[] = [];
  let pending = Promise.resolve();
  const limited = () => {
    const at = clock();
    failures = failures.filter((time) => time > at - WINDOW_MS);
    const oldest = failures[0];
    return failures.length >= FAILURE_LIMIT && oldest !== undefined
      ? Response.json(
          { error: 'too many pairing attempts' },
          {
            headers: {
              'cache-control': 'no-store',
              'retry-after': String(Math.ceil((oldest + WINDOW_MS - at) / 1000)),
            },
            status: 429,
          },
        )
      : null;
  };
  return async (request: Request) => {
    const refusal = limited();
    if (refusal) {
      return refusal;
    }
    const input: unknown = await request.json().catch(() => null);
    // Serialize the limit check with redemption so concurrent failures cannot admit a sixth try.
    // oxlint-disable-next-line promise/prefer-await-to-then -- Queue this redemption behind the prior result.
    const result = pending.then(async () => {
      const blocked = limited();
      if (blocked) {
        return blocked;
      }
      let credential: Awaited<ReturnType<typeof tokens.redeem>>;
      try {
        credential =
          typeof input === 'object' &&
          input !== null &&
          'code' in input &&
          typeof input.code === 'string'
            ? await tokens.redeem(input.code)
            : null;
      } catch {
        // Driver errors may embed credential input; log only the fault event and time.
        log(
          JSON.stringify({ event: 'pairing_redeem_fault', time: new Date(clock()).toISOString() }),
        );
        return Response.json(
          { error: 'the request did not complete' },
          { headers: { 'cache-control': 'no-store' }, status: 500 },
        );
      }
      if (credential === null) {
        const at = clock();
        failures.push(at);
        log(JSON.stringify({ event: 'pairing_redeem_failed', time: new Date(at).toISOString() }));
        return Response.json(
          { error: 'invalid pairing code' },
          { headers: { 'cache-control': 'no-store' }, status: 400 },
        );
      }
      return Response.json(credential, { headers: { 'cache-control': 'no-store' } });
    });
    // oxlint-disable-next-line promise/prefer-await-to-then -- Release the queue after success or failure.
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
