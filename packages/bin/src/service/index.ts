/** Service supervision + self-update (MMR-47). main wires realServiceDeps. */
export {
  DEFAULT_SNAPSHOT_INTERVAL_SECONDS,
  configPath,
  readConfig,
  readServeConfig,
  readVaultConfig,
  writeServePort,
} from './config';
export { cmdSelfUpdate, cmdService, type Health, type ServiceDeps } from './commands';
export { EVENTS_FILE, SERVE_LOG_FILE, SNAPSHOT_LOG_FILE } from './events';
export { LaunchdSupervisor, bunExec } from './launchd';
export { SERVE_LABEL, SNAPSHOT_LABEL, plistFor, plistForSnapshot, plistPathFor } from './plist';
export { manualFetch } from './self-update';
