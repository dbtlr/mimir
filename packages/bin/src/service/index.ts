/** Service supervision + self-update (MMR-47). main wires realServiceDeps. */
export { configPath, readServeConfig, writeServePort } from "./config";
export { cmdSelfUpdate, cmdService, type Health, type ServiceDeps } from "./commands";
export { EVENTS_FILE, SERVE_LOG_FILE } from "./events";
export { LaunchdSupervisor, bunExec } from "./launchd";
export { plistPath } from "./plist";
export { manualFetch } from "./self-update";
