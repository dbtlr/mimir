/**
 * Per-installation supervisor unit names and the supervisor fence (MMR-54,
 * refining ADR 0031). Each installation owns its own unit names: a live
 * installation keeps the historical `com.dbtlr.mimir.serve` /
 * `com.dbtlr.mimir.snapshot` (so existing installs need no migration), and a
 * sandbox installation derives names scoped to its sandbox id. The fence then
 * lets an installation drive only the units it owns, so a sandbox can exercise
 * the real supervisor without ever addressing the live daemon.
 */
import type { UnitName } from './format';

/** Which installation is asking to drive the host supervisor. `none` is a source
 *  run or an unregistered binary: it may read unit state but never mutate it. */
export type SupervisorScope = { kind: 'live' } | { kind: 'sandbox'; id: string } | { kind: 'none' };

const LABEL_PREFIX = 'com.dbtlr.mimir';
export const SERVE_LABEL = `${LABEL_PREFIX}.serve`;
export const SNAPSHOT_LABEL = `${LABEL_PREFIX}.snapshot`;

/** What the serve unit bakes into its environment, for either supervisor. */
export type ServeUnitOptions = {
  /** `MIMIR_PORT`, baked only for a non-live installation's service install. */
  port?: number;
  /**
   * `MIMIR_NORN` — the absolute path to the `norn` binary, resolved and existence-
   * checked at install time (mimir shells out to it, ADR 0018). Baked directly
   * rather than relying on `PATH`: supervisors give the daemon only a minimal
   * default `PATH` (no `$HOME/.cargo/bin`) and do no `~` expansion, so a bare
   * `norn` is unresolvable.
   */
  nornPath?: string;
  /**
   * `MIMIR_VAULT` — the absolute vault directory, existence-checked at install
   * time. Baked so the daemon targets the vault via the highest-precedence source
   * (env over config) and cannot drift with a later config edit.
   */
  vaultPath?: string;
};

export type SnapshotUnitOptions = {
  /** Seconds between snapshot runs (launchd StartInterval, systemd timer). */
  intervalSeconds: number;
  /** Baked in iff MIMIR_VAULT is set when `service install` runs (no shell expansion). */
  vaultPath?: string;
};

/** Sandbox ids are generated lowercase UUIDs; anything else never reaches a unit name. */
const SANDBOX_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The supervisor labels this scope's units use. A process without an installation
 *  reads the live names (status stays a harmless read) but may drive none of them. */
export function unitLabels(scope: SupervisorScope): Record<UnitName, string> {
  if (scope.kind !== 'sandbox') {
    return { serve: SERVE_LABEL, snapshot: SNAPSHOT_LABEL };
  }
  if (!SANDBOX_ID.test(scope.id)) {
    throw new Error(`invalid sandbox id for unit names: ${JSON.stringify(scope.id)}`);
  }
  const base = `${LABEL_PREFIX}.sandbox-${scope.id}`;
  return { serve: `${base}.serve`, snapshot: `${base}.snapshot` };
}

/** True when this scope owns the unit `label` and may therefore mutate it. */
export function mayDrive(scope: SupervisorScope, label: string): boolean {
  if (scope.kind === 'none') {
    return false;
  }
  return Object.values(unitLabels(scope)).includes(label);
}
