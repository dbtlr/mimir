import { expect, test } from 'bun:test';

import { invariant, validation } from '../errors';
import { chunkByWeight, jsonBytes, READ_LIMITS, readBodies } from './chunking';
import type { NornClient } from './client';

/**
 * The byte-bounded batching rule (NRN-s30) on its own, without a vault: it is
 * what keeps a whole-vault read under the MCP transport's response cap, and the
 * cases below are the three edges that decide whether a chunk is safe.
 */

const LIMITS = { budget: 100, ceiling: 4 };

test('a chunk closes on the byte budget, not on a document count', () => {
  const chunks = chunkByWeight([40, 40, 40, 40], (weight) => weight, LIMITS);
  expect(chunks).toEqual([
    [40, 40],
    [40, 40],
  ]);
});

test('the count ceiling closes a chunk of documents too small to spend the budget', () => {
  const chunks = chunkByWeight([1, 1, 1, 1, 1, 1], (weight) => weight, LIMITS);
  expect(chunks).toEqual([
    [1, 1, 1, 1],
    [1, 1],
  ]);
});

test('an item heavier than the whole budget rides a chunk of its own', () => {
  // The caller cannot make one oversized document smaller, so it must not drag
  // its neighbours into the same over-cap call.
  const chunks = chunkByWeight([10, 500, 10], (weight) => weight, LIMITS);
  expect(chunks).toEqual([[10], [500], [10]]);
});

test('no items means no calls (an empty target list to vault.get is unverified)', () => {
  expect(chunkByWeight([], (weight: number) => weight, LIMITS)).toEqual([]);
});

test('the default read budget keeps a chunk of maximum-sized documents under the cap', () => {
  // The observed connection-close floor is ~3 MB; the default limits must not
  // be able to ask for that much even when every document is at the largest
  // size observed on a real vault (125 KB).
  const documents = Array.from({ length: READ_LIMITS.ceiling }, () => 64 * 1024);
  const [first = []] = chunkByWeight(documents, (weight) => weight, READ_LIMITS);
  expect(first.length * 125 * 1024).toBeLessThan(3_000_000);
});

test('jsonBytes measures the wire encoding, not the key count', () => {
  expect(jsonBytes({ a: 'x' })).toBe(9);
  expect(jsonBytes(undefined)).toBe(0);
});

/**
 * The adaptive split (MMR-378). The per-document weight is an ESTIMATE — norn
 * exposes no size facet — so a vault of larger-than-assumed documents packs a
 * chunk the transport still drops. These pin the recovery: halve and retry, and
 * refuse by name when a single document is the one that cannot fit.
 */

/** A `NornClient` stand-in whose `get` fails exactly as the MCP transport does
 * once a call asks for more than `cap` bytes of body — the fault no test vault
 * is large enough to produce. Records the size of every call it was asked for. */
function cappedClient(
  cap: number,
  bodies: ReadonlyMap<string, string>,
): { calls: number[]; client: NornClient } {
  const calls: number[] = [];
  const client = {
    get: (targets: string[]) => {
      calls.push(targets.length);
      const asked = targets.reduce((sum, path) => sum + (bodies.get(path) ?? '').length, 0);
      return asked > cap
        ? Promise.reject(
            invariant('norn call vault.get failed: MCP error -32000: Connection closed'),
          )
        : Promise.resolve(
            // A path the vault does not hold yields no record, as norn does.
            targets
              .filter((path) => bodies.has(path))
              .map((path) => ({ body: bodies.get(path) ?? '', path })),
          );
    },
  };
  // The reader touches `get` alone; asserting the whole client would need a live
  // subprocess to prove nothing about the batching.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { calls, client: client as unknown as NornClient };
}

const BIG_BODIES = new Map([
  ['a.md', 'x'.repeat(100)],
  ['b.md', 'x'.repeat(100)],
  ['c.md', 'x'.repeat(100)],
  ['d.md', 'x'.repeat(100)],
]);

const BIG_TARGETS = [...BIG_BODIES.keys()].map((path) => ({ path, weight: 1 }));

test('a chunk the transport drops is halved and retried until it fits', async () => {
  // Every document is 100 bytes and the estimate says 1, so the whole set rides
  // one chunk — and the transport takes at most two documents at a time.
  const { calls, client } = cappedClient(200, BIG_BODIES);
  const bodies = await readBodies(client, BIG_TARGETS, { budget: 1000, ceiling: 100 });

  expect([...bodies.keys()].toSorted()).toEqual(['a.md', 'b.md', 'c.md', 'd.md']);
  // The failed 4 is split into two 2s, both of which fit — no further splitting.
  expect(calls).toEqual([4, 2, 2]);
});

test('a single document the transport cannot return refuses by name', async () => {
  const { client } = cappedClient(50, BIG_BODIES);
  expect(async () => {
    await readBodies(client, BIG_TARGETS, { budget: 1000, ceiling: 100 });
  }).toThrow(/a\.md is too large/);
});

test('a body read that returns no record for a requested path refuses by name', async () => {
  // An absent record is the ONLY signal that a body was not read — a genuinely
  // empty body comes back as '' — so the reader must not let a caller mistake
  // the one for the other and export a frozen artifact with empty content.
  const { client } = cappedClient(
    10_000,
    new Map([
      ['a.md', 'x'.repeat(100)],
      ['b.md', 'x'.repeat(100)],
      ['c.md', ''],
    ]),
  );
  expect(async () => {
    await readBodies(client, BIG_TARGETS, { budget: 1000, ceiling: 100 });
  }).toThrow(/d\.md/);
});

test('a failure that is not the response cap propagates untouched', async () => {
  // Only the connection close means "the payload was too big"; anything else is
  // a real fault the reader must not paper over by re-asking in halves.
  let calls = 0;
  const client = {
    get: () => {
      calls += 1;
      return Promise.reject(validation('the vault is locked'));
    },
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  } as unknown as NornClient;
  expect(async () => {
    await readBodies(client, BIG_TARGETS, { budget: 1000, ceiling: 100 });
  }).toThrow('the vault is locked');
  expect(calls).toBe(1);
});
