/** Service supervision + self-update (MMR-47, MMR-54). main wires realServiceDeps. */
export {
  DEFAULT_SNAPSHOT_INTERVAL_SECONDS,
  DEFAULT_STORE_BACKEND,
  type ConfigPatch,
  configPath,
  readConfig,
  readRuntimeConfig,
  readServeConfig,
  readVaultConfig,
  writeConfig,
  writeServePort,
} from './config';
export {
  cmdSelfUpdate,
  cmdService,
  hasSupervisor,
  type ServiceDeps,
  type ServiceUnit,
} from './commands';
export { type Health, healthSchema, parseHealth } from './health';
export { EVENTS_FILE, SERVE_LOG_FILE, SNAPSHOT_LOG_FILE } from './events';
export { LaunchdSupervisor, bunExec } from './launchd';
export { plistFor, plistForSnapshot, plistPathFor, readServePlistPort } from './plist';
export { serveInstallEnv, type ServeInstallInputs } from './serve-env';
export { manualFetch } from './self-update';
export { SystemdSupervisor } from './systemd';
export {
  readServeUnitPort,
  serveUnitFor,
  snapshotServiceUnitFor,
  snapshotTimerUnitFor,
  systemdUnitPathFor,
} from './systemd-unit';
export {
  SERVE_LABEL,
  SNAPSHOT_LABEL,
  type ServeUnitOptions,
  type SnapshotUnitOptions,
  type SupervisorScope,
  mayDrive,
  unitLabels,
} from './units';
