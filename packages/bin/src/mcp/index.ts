/**
 * The MCP transport — the agent envelope: coarse, curated, token-conscious
 * tools over the core's intent layer. Imports `core` + `contract` only.
 */
export { buildMcpServer, serveStdio } from './server';
export { type ToolResult, toolGet, toolList, toolNext, toolStatus } from './tools';
