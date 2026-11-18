import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildStore, findingsProviderOf, LocalEngine, MimirError, SQLITE_FILE } from '@mimir/core';
import { assertHostVersion, createEngineHandler } from '@mimir/wire/server';

import { createAgentConsole } from './agent-console';
import { createAgentRunner, RUNNER_TIMING } from './agent-runner';
import { agentStartupWarnings, createAgentConnection } from './agent-settings';
import { syncClone } from './clones';
import type { HostConfig } from './config';
import { createEngineViews } from './engine-view';
import { gitCredentialsWarnings } from './git-credentials';
import { createNotifier } from './notifier';
import { createPairingHandlers } from './pairing';
import { createPushChannel } from './push-channel';
import type { PushFetch } from './push-send';
import { isPushReady, pushStartupWarnings } from './push-settings';
import { createT3Adapter } from './t3';
import { t3StartupWarnings } from './t3-settings';

/** A timer the notifier arms; the host unrefs it so an open window never keeps the process alive. */
export type NotifierTimer = ReturnType<typeof setTimeout>;

/** The notifier's clocks and timers: the host's own, or a test's to drive time itself. */
export type NotifierTiming = {
  clearTimeout: (timer: NotifierTimer) => void;
  monotonicNow: () => number;
  setTimeout: (run: () => void, ms: number) => NotifierTimer;
  wallNow: () => number;
};

const REAL_NOTIFIER_TIMING: NotifierTiming = {
  clearTimeout: (timer) => clearTimeout(timer),
  monotonicNow: () => performance.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  wallNow: Date.now,
};

/**
 * What a caller may replace in `openHost`: a test drives the notifier's time
 * through it, and stands in for the push services.
 */
export type HostDependencies = { notifierTiming?: NotifierTiming; pushFetch?: PushFetch };

/** Open the host-owned store and finish migrations before exposing handlers. */
export async function openHost(
  config: HostConfig,
  version: string,
  log: (line: string) => void = (line) => console.error(line),
  { notifierTiming = REAL_NOTIFIER_TIMING, pushFetch }: HostDependencies = {},
) {
  assertHostVersion(version);
  if (config.store.backend === 'sqlite') {
    try {
      await mkdir(config.dataDirectory, { recursive: true });
      await access(config.dataDirectory, constants.W_OK);
      const file = join(config.dataDirectory, SQLITE_FILE);
      try {
        await access(file, constants.W_OK);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
          throw error;
        }
      }
    } catch {
      throw new Error('MIMIR_DATA_DIR must name a writable SQLite directory');
    }
  }
  try {
    const built = await buildStore(
      { store: config.store },
      {
        onMigration: (name) => log(`host: applied migration ${name}`),
        sqliteFile: join(config.dataDirectory, SQLITE_FILE),
        upgrade: true,
      },
    );
    // The host owns doctor; core only receives the per-project counts console.review shows.
    const store = new LocalEngine(built.store, {
      findings: findingsProviderOf(built.doctor.facet),
    });
    // The Web Push channel (ADR 0045, MMR-709): its server functions answer
    // whatever its settings allow, but the notifier sends through it only when
    // it is set up with no problem.
    const push = createPushChannel({
      ...(pushFetch === undefined ? {} : { fetch: pushFetch }),
      log,
      secrets: built.secrets,
      settings: config.push,
      subscriptions: built.pushSubscriptions,
    });
    // Operator notifications (ADR 0045): one Engine, and `createEngineViews`
    // names the view each consumer gets.
    const notifier = createNotifier<NotifierTimer>({
      channels: isPushReady(config.push) ? [push] : [],
      clearTimer: (timer) => notifierTiming.clearTimeout(timer),
      log,
      monotonicNow: notifierTiming.monotonicNow,
      reads: {
        deliveryTitle: async (id) => (await store.getDelivery({ id })).title,
        review: (input) => store.console.review(input),
      },
      setTimer: (run, ms) => {
        const timer = notifierTiming.setTimeout(run, ms);
        timer.unref();
        return timer;
      },
      wallNow: notifierTiming.wallNow,
    });
    const views = createEngineViews(store, notifier.marks);
    const pairing = createPairingHandlers({ log, tokens: built.tokens });
    // An optional integration's bad setting warns and degrades; it never refuses startup.
    for (const warning of [
      ...t3StartupWarnings(config.t3),
      ...pushStartupWarnings(config.push),
      ...gitCredentialsWarnings(config.gitCredentials),
      ...agentStartupWarnings(config.agent),
    ]) {
      log(warning);
    }
    // A run whose runner stopped heartbeating, such as one a crashed container
    // held, frees the slot here. A live run on an overlapping container keeps
    // heartbeating, so boot alone never interrupts it (ADR 0041).
    const interrupted = await built.runs.recoverStale(RUNNER_TIMING.staleAfterMs);
    if (interrupted.length > 0) {
      log(
        `host: interrupted ${interrupted.length} agent run${interrupted.length === 1 ? '' : 's'} whose runner stopped heartbeating`,
      );
    }
    // The agent runtime (ADR 0041): host-internal, started only by host server code.
    const agent = createAgentRunner({
      connection: createAgentConnection(),
      engine: views.agentRuns,
      gitCredentials: config.gitCredentials,
      log,
      query,
      // One id per host process: the rows it admits are its own.
      runnerId: randomUUID(),
      runs: built.runs,
      settings: config.agent,
      syncClone,
    });
    const t3 = createT3Adapter({
      engine: views.t3,
      log,
      secrets: built.secrets,
      settings: config.t3,
      version,
    });
    // The first read of the set, before any request: it emits nothing and never refuses startup.
    await notifier.boot();
    return {
      agent,
      // The agent runtime's console surface (MMR-633): the task card, Now, and Groom with agent.
      agentConsole: createAgentConsole({ agent, engine: views.console, log, runs: built.runs }),
      close: async () => {
        notifier.close();
        await built.close();
      },
      // The record-health facet: a host concern, not an Engine method (ADR 0034).
      doctor: built.doctor.facet,
      engine: views.console,
      handlePairingPoll: pairing.poll,
      handlePairingRequest: pairing.request,
      handleT3Callback: t3.callback,
      handleTrpc: createEngineHandler(views.trpc, { verifyToken: built.tokens.verify, version }),
      // The host's log line sink, for console functions that log beside the adapters.
      log,
      // The Web Push channel's console operations (ADR 0045, MMR-709): a host concern beside the Engine.
      push,
      // Host-only run records (ADR 0041); never reached through the Engine or the wire.
      runs: built.runs,
      // The T3 adapter: a host concern beside the Engine (ADR 0040).
      t3,
      tokens: built.tokens,
    };
  } catch (error) {
    if (error instanceof MimirError && error.hint?.includes('newer schema')) {
      throw new Error(`${error.message}; update the image; a newer schema is never downgraded`, {
        cause: error,
      });
    }
    throw error;
  }
}
