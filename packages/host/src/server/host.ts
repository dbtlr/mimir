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
import { gitCredentialsWarnings } from './git-credentials';
import { createPairingHandlers } from './pairing';
import { createT3Adapter } from './t3';
import { t3StartupWarnings } from './t3-settings';

/** Open the host-owned store and finish migrations before exposing handlers. */
export async function openHost(
  config: HostConfig,
  version: string,
  log: (line: string) => void = (line) => console.error(line),
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
    const engine = new LocalEngine(built.store, {
      findings: findingsProviderOf(built.doctor.facet),
    });
    const pairing = createPairingHandlers({ log, tokens: built.tokens });
    // An optional integration's bad setting warns and degrades; it never refuses startup.
    for (const warning of [
      ...t3StartupWarnings(config.t3),
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
      engine,
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
      engine,
      log,
      secrets: built.secrets,
      settings: config.t3,
      version,
    });
    return {
      agent,
      // The agent runtime's console surface (MMR-633): the task card, Now, and Groom with agent.
      agentConsole: createAgentConsole({ agent, engine, log, runs: built.runs }),
      close: built.close,
      // The record-health facet: a host concern, not an Engine method (ADR 0034).
      doctor: built.doctor.facet,
      engine,
      handlePairingPoll: pairing.poll,
      handlePairingRequest: pairing.request,
      handleT3Callback: t3.callback,
      handleTrpc: createEngineHandler(engine, { verifyToken: built.tokens.verify, version }),
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
