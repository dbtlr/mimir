import { openSecret, sealSecret } from '@mimir/core';
import type { HostSecretStore, SecretKey } from '@mimir/core';

import { logEvent } from './log-event';
import { generateVapidKeys, readVapidKeys } from './push-protocol';
import type { VapidKeys } from './push-protocol';

/*
 * The Web Push channel's VAPID key (ADR 0045, the MMR-709 refinement): one
 * pair, sealed as the host secret `push.vapid`. Every use reads and opens the
 * row again; nothing is cached between uses, so a host always signs with the
 * key the store holds.
 */

/** The host secret that holds the sealed pair. */
export const PUSH_SECRET_NAME = 'push.vapid';

/** Why a row fails to open, in the words T3's log uses for its own row. */
const UNOPENABLE_CAUSE = 'the row failed authentication: the key changed or the row was altered';

/** The key a use signs with, or why there is none: the row does not open to a valid pair. */
export type VapidKeyState = { state: 'ready'; keys: VapidKeys } | { state: 'key_unusable' };

export type VapidKeyringOptions = {
  secrets: HostSecretStore;
  key: SecretKey;
  log: (line: string) => void;
  clock: () => number;
};

/** Wait for a turn to settle, whichever way. */
async function settled(turn: Promise<unknown>): Promise<void> {
  try {
    await turn;
  } catch {
    // A failed turn is the caller's to see; the next turn starts regardless.
  }
}

/**
 * One turn at a time: each run starts after the one before it settles, and a
 * failed run is not remembered by the next.
 */
function createTurns() {
  let last: Promise<void> = Promise.resolve();
  return <T>(run: () => Promise<T>): Promise<T> => {
    const previous = last;
    const turn = (async () => {
      await previous;
      return run();
    })();
    last = settled(turn);
    return turn;
  };
}

/**
 * The pair's reads, its first making, and its reset. A store error while
 * reading or writing the row rejects; it is never taken for an absent row.
 */
export function createVapidKeyring({ clock, key, log, secrets }: VapidKeyringOptions) {
  const takeTurn = createTurns();
  /** Each unusable row content already logged, so a row is logged once per process. */
  const logged = new Set<string>();

  const logOnce = (event: 'host_secret_unopenable' | 'host_secret_unreadable', sealed: string) => {
    const mark = `${event}\0${sealed}`;
    if (!logged.has(mark)) {
      logged.add(mark);
      logEvent({ clock, log }, event, {
        ...(event === 'host_secret_unopenable' ? { cause: UNOPENABLE_CAUSE } : {}),
        name: PUSH_SECRET_NAME,
      });
    }
  };

  /** Open a row: the pair it holds, or key unusable (logged without contents). */
  const openRow = async (sealed: string): Promise<VapidKeyState> => {
    const opened = openSecret(key, PUSH_SECRET_NAME, sealed);
    if (opened === undefined) {
      logOnce('host_secret_unopenable', sealed);
      return { state: 'key_unusable' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(opened);
    } catch {
      parsed = undefined;
    }
    const keys = await readVapidKeys(parsed);
    if (keys === undefined) {
      logOnce('host_secret_unreadable', sealed);
      return { state: 'key_unusable' };
    }
    return { keys, state: 'ready' };
  };

  const sealedPair = async () =>
    sealSecret(key, PUSH_SECRET_NAME, JSON.stringify(await generateVapidKeys()));

  /** The row as it stands after a write; its absence then is a fault. */
  const readBack = async (): Promise<string> => {
    const sealed = await secrets.read(PUSH_SECRET_NAME);
    if (sealed === undefined) {
      throw new Error(`the ${PUSH_SECRET_NAME} host secret was missing after its write`);
    }
    return sealed;
  };

  /** The row's pair; with no row, insert a new pair only if none exists, then use whatever the row holds. */
  const readOrMake = async (): Promise<VapidKeyState> => {
    const sealed = await secrets.read(PUSH_SECRET_NAME);
    if (sealed !== undefined) {
      return openRow(sealed);
    }
    await secrets.insertIfAbsent(PUSH_SECRET_NAME, await sealedPair());
    return openRow(await readBack());
  };

  return {
    /** The key this use signs with, making the pair when no row exists. */
    current: async (): Promise<VapidKeyState> => {
      const sealed = await secrets.read(PUSH_SECRET_NAME);
      return sealed === undefined ? takeTurn(readOrMake) : openRow(sealed);
    },
    /**
     * In one turn: write a new pair over the row, read it back, and run
     * `then` with the pair read back; answer that pair.
     */
    reset: (then: (keys: VapidKeys) => Promise<unknown>): Promise<VapidKeys> =>
      takeTurn(async () => {
        await secrets.write(PUSH_SECRET_NAME, await sealedPair());
        const stored = await openRow(await readBack());
        if (stored.state !== 'ready') {
          throw new Error(`the ${PUSH_SECRET_NAME} host secret did not open after its reset`);
        }
        await then(stored.keys);
        return stored.keys;
      }),
    /**
     * Run with the current key (made when no row exists) in one turn, so no
     * reset in this process lands between the key's read and the run's end.
     */
    withCurrent: <T>(run: (key: VapidKeyState) => Promise<T>): Promise<T> =>
      takeTurn(async () => run(await readOrMake())),
  };
}

export type VapidKeyring = ReturnType<typeof createVapidKeyring>;
