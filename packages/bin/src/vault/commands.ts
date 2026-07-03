/**
 * The `vault` command family (MMR-146). `vault snapshot` is its first verb: the
 * git commit cadence, run manually or by the scheduled launchd unit. Effects
 * flow through VaultDeps so tests drive the layer with fakes; main wires the
 * real edges.
 *
 * Output honors the CLI contract: alerts (a state needing a human) go to stderr
 * and set a nonzero exit; a success line goes to stdout — the launchd unit's
 * stdout is a log file, so the line is useful there and the loud signal is the
 * exit code, not stdout emptiness.
 */
import { usage } from '../cli/errors';
import { ok, warn } from '../cli/render';
import type { Format, Io } from '../cli/render';
import type { Exec } from '../exec';
import type { SnapshotConfig } from '../service/config';
import type { ResolvedVault } from './resolve';
import { snapshotVault } from './snapshot';
import type { SnapshotResult } from './snapshot';

export type VaultDeps = {
  exec: Exec;
  /** Resolve the vault location from env + config (MMR-142 precedence). */
  resolveVault: () => ResolvedVault;
  /** The validated `[vault.snapshot]` config — defaults applied by the core. */
  snapshotConfig: () => SnapshotConfig;
  /** ISO timestamp for the commit message — injected so tests are deterministic. */
  stamp: () => string;
};

const SUBCOMMANDS = ['snapshot'] as const;

export async function cmdVault(
  positionals: string[],
  io: Io,
  deps: VaultDeps,
  format: Format,
): Promise<number> {
  const sub = positionals[1];
  if (sub !== 'snapshot') {
    throw usage(`vault: unknown subcommand (expected: ${SUBCOMMANDS.join(' | ')})`);
  }
  return await cmdVaultSnapshot(io, deps, format);
}

async function cmdVaultSnapshot(io: Io, deps: VaultDeps, format: Format): Promise<number> {
  const vault = deps.resolveVault();
  const cfg = deps.snapshotConfig();
  const result = await snapshotVault({
    exec: deps.exec,
    path: vault.path,
    pull: cfg.pull,
    push: cfg.push,
    stamp: deps.stamp(),
    upstream: cfg.upstream,
  });

  if (format === 'json' || format === 'jsonl') {
    io.write(JSON.stringify(result));
  } else {
    // Alerts are the loud channel: stderr + a nonzero exit. Success is one
    // human line on stdout.
    for (const a of result.alerts) {
      warn(io, `snapshot: ${a}`);
    }
    if (result.alerts.length === 0) {
      ok(io, `snapshot: ${describe(result)}`);
    }
  }
  return result.alerts.length > 0 ? 1 : 0;
}

/** A one-line human summary of a successful (alert-free) snapshot. */
function describe(r: SnapshotResult): string {
  const where = r.branch === undefined ? '' : ` (${r.branch})`;
  const summaries: Record<SnapshotResult['outcome'], string> = {
    clean: `nothing to commit${where}`,
    committed: `committed${where}`,
    pushed: `${r.committed ? 'committed and ' : ''}pushed${where}`,
    reconciled: `reconciled with upstream and pushed${where}`,
  };
  return summaries[r.outcome];
}
