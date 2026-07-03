/**
 * `mimir setup` (MMR-145) — the replayable configuration wizard. One command
 * for the first install and every later reconfiguration: it prefills the
 * current answers, converges the vault at the chosen location, writes the
 * global config, and installs the launchd units — all idempotent, so re-running
 * is safe.
 *
 * Interactive at a TTY; non-interactively it reads flags and requires `-y`
 * (like `create project`) so a piped `mimir setup` never converges a vault or
 * schedules a daemon behind the operator's back. Effects flow through the
 * already-wired service + vault deps; the store is never opened (MMR-39).
 */
import { cmdService } from '../service';
import type { ServiceDeps } from '../service';
import { DEFAULT_SNAPSHOT_INTERVAL_SECONDS, readConfig, writeConfig } from '../service/config';
import type { SnapshotConfig } from '../service/config';
import { converge } from '../vault';
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
  snapshot: SnapshotConfig;
};

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
  const answer = globalThis.prompt(`${question} [${def}]`);
  return answer === null || answer.trim() === '' ? def : answer.trim();
}

/**
 * Gather answers interactively. Service/snapshot questions are macOS-only
 * (launchd); off darwin they are skipped with a note and left uninstalled.
 */
function askInteractive(values: SetupValues, deps: SetupDeps, io: Io): SetupAnswers {
  const cfg = readConfig(deps.service.configFile);
  const vaultPath = askLine(
    'Vault location',
    values.vault ?? cfg.vault.path ?? deps.defaultVaultPath,
  );

  if (deps.service.platform !== 'darwin') {
    io.write(
      'Background service (launchd) is macOS-only — skipping; run `mimir serve` under your supervisor.',
    );
    return { installService: false, installSnapshot: false, snapshot: {}, vaultPath };
  }

  const installService = globalThis.confirm('Install the background service (mimir serve)?');
  let port: number | undefined;
  if (installService) {
    const def = values.port ?? (cfg.serve.port === undefined ? '' : String(cfg.serve.port));
    const answer = askLine('Service port (blank = default)', def);
    port = answer === '' ? undefined : parsePort(answer);
  }

  const installSnapshot = globalThis.confirm(
    'Install the auto-snapshot timer (commit + push the vault)?',
  );
  const snapshot: SnapshotConfig = {};
  if (installSnapshot) {
    const defInterval = String(
      values.snapshotInterval ?? cfg.vault.snapshot?.interval ?? DEFAULT_SNAPSHOT_INTERVAL_SECONDS,
    );
    snapshot.interval = parseInterval(askLine('Snapshot interval (seconds)', defInterval));
    const upstream = askLine(
      'Snapshot upstream remote (blank = none)',
      values.upstream ?? cfg.vault.snapshot?.upstream ?? '',
    );
    if (upstream !== '') {
      snapshot.upstream = upstream;
    }
  }
  return { installService, installSnapshot, port, snapshot, vaultPath };
}

/** Gather answers from flags (the non-interactive path — requires `-y`). */
function fromFlags(values: SetupValues, deps: SetupDeps): SetupAnswers {
  const cfg = readConfig(deps.service.configFile);
  const installService = values.installService === true;
  const installSnapshot = values.installSnapshot === true;
  const snapshot: SnapshotConfig = {};
  if (values.snapshotInterval !== undefined) {
    snapshot.interval = parseInterval(values.snapshotInterval);
  }
  if (values.upstream !== undefined && values.upstream !== '') {
    snapshot.upstream = values.upstream;
  }
  return {
    installService,
    installSnapshot,
    port: values.port === undefined ? undefined : parsePort(values.port),
    snapshot,
    vaultPath: values.vault ?? cfg.vault.path ?? deps.defaultVaultPath,
  };
}

/** Converge the vault, persist config, install units. */
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

  // 2. Persist the whole config in one write: the vault location (+ snapshot
  //    cadence) so serve/snapshot resolve it, and the serve port whenever given
  //    — it is a `[serve]` setting `mimir serve` reads on its own, so it is
  //    honored even without installing the launchd unit. Install below reads the
  //    port back from here rather than being handed it again.
  const snapshot = answers.snapshot;
  writeConfig(deps.service.configFile, {
    ...(answers.port === undefined ? {} : { serve: { port: answers.port } }),
    vault: {
      path: answers.vaultPath,
      ...(Object.keys(snapshot).length > 0 ? { snapshot } : {}),
    },
  });

  // 3. Install the selected launchd units in one call. Off darwin there are no
  //    launchd units — skip with a note rather than letting service install
  //    throw; the vault + config above still landed.
  const darwin = deps.service.platform === 'darwin';
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

  if (structured) {
    io.write(
      JSON.stringify({
        configFile: deps.service.configFile,
        service: { ok: serviceOk, units },
        vault: { outcome: result.outcome, path: answers.vaultPath },
      }),
    );
  } else {
    const where = answers.vaultPath;
    ok(io, result.outcome === 'created' ? `vault created at ${where}` : `vault ready at ${where}`);
    ok(io, `config written → ${deps.service.configFile}`);
    if (units.length === 0) {
      io.write('no launchd units installed (re-run and opt in, or `mimir service install`)');
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
  const answers =
    io.isTTY && values.yes !== true ? askInteractive(values, deps, io) : fromFlags(values, deps);
  return await applySetup(answers, io, deps, format);
}
