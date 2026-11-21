/**
 * `mimir mcp` serves over stdin and stdout only (ADR 0010). Loom's `mcp()`
 * also offers `mcp --http`, which would serve every tool, writes included, to
 * any local process with no authentication unless the application supplies
 * one. This plugin refuses `--http` before any server starts, and
 * `refuseHttp` is the `authorize` hook that answers 401 to every HTTP request
 * should one start anyway.
 */
import { plugin } from '@loomcli/core';
import type { Middleware, Plugin } from '@loomcli/core';

import { MimirUsageError } from './failures';

/** The `authorize` hook for `mcp()`: no HTTP request is ever served. */
export const refuseHttp = (): boolean => false;

const refuseHttpServe: Middleware<Plugin> = async (context) => {
  const path = context.command.path;
  if (path.length === 1 && path[0] === 'mcp' && context.request?.options.http !== undefined) {
    throw new MimirUsageError(
      'mimir serves MCP over stdin and stdout only; run mimir mcp without --http',
    );
  }
  await context.next();
};

/** Install after `mcp()`, so the refusal sees the `mcp` Command's options. */
export function stdioMcp(): Plugin {
  return plugin('@mimir/cli/stdio-mcp', {
    middleware: { activate: 'always', load: () => Promise.resolve({ default: refuseHttpServe }) },
  });
}
