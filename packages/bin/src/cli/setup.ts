/**
 * `mimir setup` (MMR-145) — the configuration wizard. One command for the first
 * install and every later reconfiguration: it prefills the current answers,
 * writes the global config, and installs (or updates) the background service if
 * you opt in. Re-running is safe — every action converges to the answered state.
 *
 * The store itself needs nothing set up: the local SQLite file is created on
 * first use (ADR 0032), and a Postgres install is configured by its `[store]`
 * section. So setup asks only about the service.
 *
 * It installs and updates; it never *removes* the service. Declining it when it
 * is already installed leaves it running and says so, pointing at
 * `mimir service uninstall` — the deliberate, separate teardown door.
 *
 * Interactive at a TTY; non-interactively it reads flags and requires `-y`
 * (like `create project`) so a piped `mimir setup` never schedules a daemon
 * behind the operator's back. Effects flow through the already-wired service
 * deps; the store is never opened (MMR-39).
 */
import { existsSync } from 'node:fs';

import { arrow, ok, warn } from '../presentation';
import type { Format, Io } from '../presentation';
import { cmdService, hasSupervisor } from '../service';
import type { ServiceDeps } from '../service';
import {
  DEFAULT_STORE_BACKEND,
  isUnparseableConfig,
  readConfig,
  writeConfig,
} from '../service/config';
import type { GlobalConfig, StoreBackend } from '../service/config';
import { assertUsableStoreConfig } from '../store-backend';
import { usage } from './errors';

export type SetupDeps = {
  service: ServiceDeps;
  /** The local store's database file — reported, never opened (MMR-39). */
  sqlitePath: string;
};

/** The raw flag surface (the non-interactive answers). */
export type SetupValues = {
  port?: string;
  installService?: boolean;
  yes?: boolean;
};

/** The resolved answers, from prompts or flags — the input to {@link applySetup}. */
type SetupAnswers = {
  backend: StoreBackend;
  installService: boolean;
  port?: number;
};

/** The service needs a supervisor: launchd (macOS) or systemd (Linux). */
function supervisorAvailable(deps: SetupDeps): boolean {
  return hasSupervisor(deps.service.platform);
}

/** Parse a port flag/answer, or throw a usage fault. */
function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw usage(`setup: --port expects an integer in 1–65535 (got ${raw})`);
  }
  return port;
}

/** Prompt for a line, falling back to `def` on empty input or EOF. */
function askLine(question: string, def: string): string {
  const answer = globalThis.prompt(def === '' ? question : `${question} [${def}]`);
  return answer === null || answer.trim() === '' ? def : answer.trim();
}

/**
 * Gather answers interactively. The service question needs a supervisor;
 * without one it is skipped with a note (the config still lands).
 */
function askInteractive(values: SetupValues, deps: SetupDeps, io: Io): SetupAnswers {
  const cfg = readConfig(deps.service.configFile);
  const backend = configuredBackend(cfg, deps);

  if (!supervisorAvailable(deps)) {
    io.write(
      'Background service needs launchd (macOS) or systemd (Linux) — skipping; run `mimir serve` under your supervisor.',
    );
    return { backend, installService: false };
  }

  const installService = globalThis.confirm('Install the background service (mimir serve)?');
  let port: number | undefined;
  if (installService) {
    const current = cfg.serve.port;
    const def = values.port ?? (current === undefined ? '' : String(current));
    // Only when no port is set can a blank line mean "the built-in default";
    // with one already set, the prefill is shown and a blank keeps it.
    const label =
      current === undefined ? 'Service port (blank = built-in default)' : 'Service port';
    const answer = askLine(label, def);
    port = answer === '' ? undefined : parsePort(answer);
  }
  return { backend, installService, port };
}

/**
 * The backend the config fences this install to, before any answer is asked
 * for. An unusable `[store]` section is refused rather than read as the
 * default: setup would otherwise report success over a config every store
 * command then refuses.
 */
function configuredBackend(cfg: GlobalConfig, deps: SetupDeps): StoreBackend {
  // A file that is not TOML at all is rewritten fresh, with a warning (see
  // applySetup), so only a parsed file's bad section is refused here.
  if (!isUnparseableConfig(deps.service.configFile)) {
    assertUsableStoreConfig(cfg, deps.service.configFile);
  }
  return cfg.store.backend ?? DEFAULT_STORE_BACKEND;
}

/** Gather answers from flags (the non-interactive path — requires `-y`). */
function fromFlags(values: SetupValues, deps: SetupDeps): SetupAnswers {
  const cfg = readConfig(deps.service.configFile);
  return {
    backend: configuredBackend(cfg, deps),
    installService: values.installService === true,
    port: values.port === undefined ? undefined : parsePort(values.port),
  };
}

/** Persist config, then install the service if opted in. */
async function applySetup(
  answers: SetupAnswers,
  io: Io,
  deps: SetupDeps,
  format: Format,
): Promise<number> {
  const structured = format === 'json' || format === 'jsonl';

  // 1. Persist the serve port whenever given — a `[serve]` setting `mimir serve`
  //    reads on its own, so honored even without the supervisor unit. Install
  //    below reads the port back from here rather than being handed it again.
  const { reset } = writeConfig(
    deps.service.configFile,
    answers.port === undefined ? {} : { serve: { port: answers.port } },
  );
  if (reset) {
    warn(io, `existing config at ${deps.service.configFile} was not valid TOML — rewrote it fresh`);
  }

  // 2. Install the service if opted in. Without a supervisor there is no unit —
  //    skip with a note rather than letting service install throw; the config
  //    above still landed.
  const supervised = supervisorAvailable(deps);
  const units: string[] = supervised && answers.installService ? ['serve'] : [];
  if (!supervised && answers.installService) {
    warn(
      io,
      'the service needs launchd (macOS) or systemd (Linux) — skipped; run `mimir serve` under your supervisor',
    );
  }
  let serviceOk = true;
  if (units.length > 0) {
    // In structured mode, suppress service install's own stdout envelope so
    // setup emits one object; warnings (stderr) still surface. The port was
    // already persisted in step 1, so install reads it from the config.
    const serviceIo: Io = structured ? { ...io, write: () => undefined } : io;
    const code = await cmdService(
      ['service', 'install', 'serve'],
      { port: answers.port === undefined ? undefined : String(answers.port) },
      serviceIo,
      { ...deps.service, readConfig },
      format,
    );
    serviceOk = code === 0;
  }

  // Setup installs and updates; it never removes. A service left installed
  // because it wasn't opted into this run is called out, not silently kept.
  const leftInstalled =
    supervised && units.length === 0 && existsSync(deps.service.units.serve.unitFile)
      ? ['serve']
      : [];

  if (structured) {
    io.write(
      JSON.stringify({
        configFile: deps.service.configFile,
        service: { leftInstalled, ok: serviceOk, units },
        store: storeReport(answers.backend, deps),
      }),
    );
  } else {
    ok(io, storeLine(answers.backend, deps));
    ok(io, `config written ${arrow(io.plain)} ${deps.service.configFile}`);
    for (const n of leftInstalled) {
      warn(io, `${n} is still installed — remove it with \`mimir service uninstall ${n}\``);
    }
    ok(io, 'setup complete');
  }
  return serviceOk ? 0 : 1;
}

/** The store this install runs on — the local file, or the server. */
function storeReport(
  backend: StoreBackend,
  deps: SetupDeps,
): { backend: StoreBackend; path?: string } {
  return backend === 'sqlite' ? { backend, path: deps.sqlitePath } : { backend };
}

function storeLine(backend: StoreBackend, deps: SetupDeps): string {
  return backend === 'sqlite'
    ? `local store at ${deps.sqlitePath} (created on first use)`
    : `store: ${backend} — its connection is [store] in the config`;
}

export async function cmdSetup(
  values: SetupValues,
  io: Io,
  deps: SetupDeps,
  format: Format,
): Promise<number> {
  // A non-interactive run must be explicit: flags carry the answers and `-y`
  // asserts intent, mirroring the `create project` gate.
  if (!io.isTTY && values.yes !== true) {
    throw usage(
      'setup needs a TTY, or flags with -y to run non-interactively',
      'e.g. mimir setup --install-service -y',
    );
  }
  const answers =
    io.isTTY && values.yes !== true ? askInteractive(values, deps, io) : fromFlags(values, deps);
  return await applySetup(answers, io, deps, format);
}
