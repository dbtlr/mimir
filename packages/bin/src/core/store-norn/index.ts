// The client surface is re-exported type-only: barrel consumers want the pure
// store projections; a value re-export of NornClient would make every barrel
// import evaluate client.ts (and the MCP SDK it pulls in). Construct a real
// client via a deep import of './client'.
export type {
  NornClient,
  NornClientOptions,
  NornDocument,
  NornFindArgs,
  NornSelection,
  NornSetArgs,
  NornToolName,
} from './client';
export type {
  NodeRefs,
  NornSnapshot,
  ProjectDeclaration,
  SeedRefs,
  VaultGraph,
  VaultGraphSource,
} from './store';
export {
  loadNodesForProjectsOverNorn,
  loadNornSnapshot,
  loadProjectsOverNorn,
  loadWorkingSetOverNorn,
  readVaultGraph,
  vaultGraphFromDocs,
} from './store';
