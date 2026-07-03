/**
 * `mimir setup` (MMR-145) — the configuration wizard. One command for the first
 * install and every later reconfiguration: it prefills the current answers,
 * converges the vault at the chosen location, writes the global config, and
 * installs (or updates) the launchd units you opt into. Re-running is safe —
 * every action converges to the answered state.
 *
 * It installs and updates; it never *removes* a launchd unit. Declining a unit
 * that is already installed leaves it running and says so, pointing at
 * `mimir service uninstall` — the deliberate, separate teardown door.
 *
 * Interactive at a TTY; non-interactively it reads flags and requires `-y`
 * (like `create project`) so a piped `mimir setup` never converges a vault or
 * schedules a daemon behind the operator's back. Effects flow through the
 * already-wired service + vault deps; the store is never opened (MMR-39).
 */
import { existsSync } from 'node:fs';

import { cmdService } from '../service';
import type { ServiceDeps } from '../service';
import { DEFAULT_SNAPSHOT_INTERVAL_SECONDS, readConfig, writeConfig } from '../service/config';
import type { SnapshotConfig } from '../service/config';
import { converge, expandTilde } from '../vault';
import type { VaultDeps } from '../vault/commands';
import { usage } from './errors';
import { ok, warn } from './render';
import type { Format, Io } from './render';

export type SetupDeps = {
  service: ServiceDeps;
  vault: VaultDeps;
  /** The build's default vault path — the prefilled location answer. */
  defaultVaultPath: string;
};

/** The raw flag surface (the non-interactive answers). */
export type SetupValues = {
  vault?: string;
  port?: string;
  installService?: boolean;
  installSnapshot?: boolean;
  snapshotInterval?: string;
  upstream?: string;
  yes?: boolean;
};

/** The resolved answers, from prompts or flags — the input to {@link applySetup}. */
type SetupAnswers = {
  vaultPath: string;
  installService: boolean;
  port?: number;
  installSnapshot: boolean;
  /** The snapshot cadence to persist — only meaningful when `installSnapshot`. */
  snapshot: SnapshotConfig;
};

/** launchd (and therefore the service/snapshot units) is macOS-only. */
function launchdAvailable(deps: SetupDeps): boolean {
  return deps.service.platform === 'darwin';
}

/** Parse a port flag/answer, or throw a usage fault. */
function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw usage(`setup: --port expects an integer in 1–65535 (got ${raw})`);
  }
  return port;
}

/** Parse a snapshot-interval flag/answer, or throw a usage fault. */
function parseInterval(raw: string): number {
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < 1) {
    throw usage(`setup: --snapshot-interval expects a positive integer of seconds (got ${raw})`);
  }
  return seconds;
}

/** Prompt for a line, falling back to `def` on empty input or EOF. */
function askLine(question: string, def: string): string {
  const answer = globalThis.prompt(def === '' ? question : `${question} [${def}]`);
  return answer === null || answer.trim() === '' ? def : answer.trim();
}

/**
 * Gather answers interactively. The service/snapshot questions are launchd-only;
 * off darwin they are skipped with a note and left uninstalled (the vault +
 * config still land).
 */
function askInteractive(values: SetupValues, deps: SetupDeps, io: Io): SetupAnswers {
  const cfg = readConfig(deps.service.configFile);
  const vaultPath = expandTilde(
    askLine('Vault location', values.vault ?? cfg.vault.path ?? deps.defaultVaultPath),
  );

  if (!launchdAvailable(deps)) {
    io.write(
      'Background service (launchd) is macOS-only — skipping; run `mimir serve` under your supervisor.',
    );
    return { installService: false, installSnapshot: false, snapshot: {}, vaultPath };
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

  const installSnapshot = globalThis.confirm(
    'Install the auto-snapshot timer (commit + push the vault)?',
  );
  // Start from the current snapshot config so keys the wizard doesn't ask about
  // (push/pull) survive a reconfigure — writeConfig replaces the whole table.
  const snapshot: SnapshotConfig = { ...cfg.vault.snapshot };
  if (installSnapshot) {
    const defInterval = String(
      values.snapshotInterval ?? snapshot.interval ?? DEFAULT_SNAPSHOT_INTERVAL_SECONDS,
    );
    snapshot.interval = parseInterval(askLine('Snapshot interval (seconds)', defInterval));
    // Prefill the current upstream so Enter keeps it (like every other field);
    // a literal '-' clears it.
    const answer = askLine(
      "Snapshot upstream remote ('-' to clear)",
      values.upstream ?? snapshot.upstream ?? '',
    );
    if (answer === '-' || answer === '') {
      delete snapshot.upstream;
    } else {
      snapshot.upstream = answer;
    }
  }
  return { installService, installSnapshot, port, snapshot, vaultPath };
}

/** Gather answers from flags (the non-interactive path — requires `-y`). */
function fromFlags(values: SetupValues, deps: SetupDeps): SetupAnswers {
  const cfg = readConfig(deps.service.configFile);
  const installService = values.installService === true;
  const installSnapshot = values.installSnapshot === true;
  // Cadence belongs to the snapshot unit — reject it without --install-snapshot
  // rather than silently persisting a cadence for a timer that isn't set up.
  if (
    !installSnapshot &&
    (values.snapshotInterval !== undefined || values.upstream !== undefined)
  ) {
    throw usage('setup: --snapshot-interval / --upstream require --install-snapshot');
  }
  // Preserve push/pull (and any field not re-specified) across a reconfigure.
  const snapshot: SnapshotConfig = { ...cfg.vault.snapshot };
  if (installSnapshot) {
    snapshot.interval =
      values.snapshotInterval !== undefined
        ? parseInterval(values.snapshotInterval)
        : (snapshot.interval ?? DEFAULT_SNAPSHOT_INTERVAL_SECONDS);
    // Omitting --upstream keeps the current one (like the interactive Enter);
    // `--upstream ''` clears it, `--upstream <url>` sets it.
    if (values.upstream !== undefined) {
      if (values.upstream === '') {
        delete snapshot.upstream;
      } else {
        snapshot.upstream = values.upstream;
      }
    }
  }
  return {
    installService,
    installSnapshot,
    port: values.port === undefined ? undefined : parsePort(values.port),
    snapshot,
    vaultPath: expandTilde(values.vault ?? cfg.vault.path ?? deps.defaultVaultPath),
  };
}

/** Converge the vault, persist config, install the opted-in units. */
async function applySetup(
  answers: SetupAnswers,
  io: Io,
  deps: SetupDeps,
  format: Format,
): Promise<number> {
  const structured = format === 'json' || format === 'jsonl';

  // 1. Converge the vault at the chosen path. Setup is the explicit, interactive
  //    door where creating at a custom path is intended (resolve.ts), so
  //    allowCreate holds; a foreign non-empty dir still refuses (converge).
  const result = await converge(answers.vaultPath, { allowCreate: true, exec: deps.vault.exec });
  for (const w of result.warnings) {
    warn(io, `vault: ${w}`);
  }

  // 2. Persist the config in one write: the vault location, the serve port
  //    whenever given (a `[serve]` setting `mimir serve` reads on its own, so
  //    honored even without the launchd unit), and the snapshot cadence when
  //    the snapshot unit is being set up. Snapshot is written authoritatively —
  //    the table becomes exactly what was gathered. Install below reads the port
  //    back from here rather than being handed it again.
  writeConfig(deps.service.configFile, {
    ...(answers.port === undefined ? {} : { serve: { port: answers.port } }),
    vault: {
      path: answers.vaultPath,
      ...(answers.installSnapshot ? { snapshot: answers.snapshot } : {}),
    },
  });

  // 3. Install the opted-in launchd units in one call. Off darwin there are no
  //    launchd units — skip with a note rather than letting service install
  //    throw; the vault + config above still landed.
  const darwin = launchdAvailable(deps);
  const units: string[] = [];
  if (darwin && answers.installService) {
    units.push('serve');
  }
  if (darwin && answers.installSnapshot) {
    units.push('snapshot');
  }
  if (!darwin && (answers.installService || answers.installSnapshot)) {
    warn(io, 'launchd units are macOS-only — skipped; run `mimir serve` under your supervisor');
  }
  let serviceOk = true;
  if (units.length > 0) {
    const selector = units.length === 2 ? 'all' : (units[0] ?? 'serve');
    // In structured mode, suppress service install's own stdout envelope so
    // setup emits one object; warnings (stderr) still surface. The port was
    // already persisted in step 2, so install reads it from the config.
    const serviceIo: Io = structured ? { ...io, write: () => undefined } : io;
    const code = await cmdService(
      ['service', 'install', selector],
      {},
      serviceIo,
      deps.service,
      format,
    );
    serviceOk = code === 0;
  }

  // Setup installs and updates; it never removes. A unit left installed because
  // it wasn't opted into this run is called out, not silently kept.
  const leftInstalled = darwin
    ? (['serve', 'snapshot'] as const).filter(
        (n) => !units.includes(n) && existsSync(deps.service.units[n].plistFile),
      )
    : [];

  if (structured) {
    io.write(
      JSON.stringify({
        configFile: deps.service.configFile,
        service: { leftInstalled, ok: serviceOk, units },
        vault: { outcome: result.outcome, path: answers.vaultPath },
      }),
    );
  } else {
    const where = answers.vaultPath;
    ok(io, result.outcome === 'created' ? `vault created at ${where}` : `vault ready at ${where}`);
    ok(io, `config written → ${deps.service.configFile}`);
    for (const n of leftInstalled) {
      warn(io, `${n} is still installed — remove it with \`mimir service uninstall ${n}\``);
    }
    ok(io, 'setup complete');
  }
  return serviceOk ? 0 : 1;
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
      'e.g. mimir setup --vault ~/.local/share/mimir/vault --install-service -y',
    );
  }
  // An unparseable config can't be merged into — writeConfig rewrites it fresh.
  // Say so up front rather than dropping the old content silently.
  if (readConfig(deps.service.configFile).serve.problem === 'malformed') {
    warn(io, `existing config at ${deps.service.configFile} was not valid TOML — rewriting it`);
  }
  const answers =
    io.isTTY && values.yes !== true ? askInteractive(values, deps, io) : fromFlags(values, deps);
  return await applySetup(answers, io, deps, format);
}
