/** Service supervision + self-update (MMR-47, MMR-54). main wires realServiceDeps. */
export {
  DEFAULT_STORE_BACKEND,
  type ConfigPatch,
  configPath,
  readConfig,
  readRuntimeConfig,
  readServeConfig,
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
export { EVENTS_FILE, SERVE_LOG_FILE } from './events';
export { LaunchdSupervisor, bunExec } from './launchd';
export { plistFor, plistPathFor, readServePlistPort } from './plist';
export { manualFetch } from './self-update';
export { SystemdSupervisor } from './systemd';
export { readServeUnitPort, serveUnitFor, systemdUnitPathFor } from './systemd-unit';
export {
  SERVE_LABEL,
  type ServeUnitOptions,
  type SupervisorScope,
  mayDrive,
  unitLabels,
} from './units';
