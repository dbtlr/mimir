import { expect, test } from 'bun:test';

import { consoleSchemas, engineSchemas } from '@mimir/contract';
import { inertStore } from '@mimir/core/testing';

import { COMMAND_HELP } from './cli/help';
import { buildMcpServer } from './mcp/server';

/**
 * Every CLI and MCP read is covered by an Engine method, and the console's
 * `console.*` methods stay off both surfaces (ADR 0034, decisions 6 and the
 * 2026-10-18 refinement). Writes join this table as their phases land.
 */

/** Each MCP read tool and the Engine method(s) it runs through. */
const MCP_READS: Readonly<Record<string, readonly string[]>> = {
  artifacts: ['artifacts'],
  get: ['getNode', 'getArtifact'],
  get_seed: ['getSeed'],
  list: ['list'],
  next: ['next'],
  overview: ['overview'],
  projects: ['projects'],
  scratch_get: ['scratchGet'],
  scratch_list: ['scratchList'],
  search: ['search'],
  seeds: ['seeds'],
  status: ['status'],
};

/** Engine methods reached through a CLI command or a uniform verb rather than an MCP read tool. */
const OTHER_SURFACE: Readonly<Record<string, string>> = {
  done: 'the uniform verb `done`',
  tree: 'the CLI `tree` command',
};

function mcpToolNames(): Set<string> {
  const server = buildMcpServer(inertStore(), '0.0.0-test');
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const internals = server as unknown as { _registeredTools: Record<string, unknown> };
  // oxlint-disable-next-line eslint/no-underscore-dangle
  return new Set(Object.keys(internals._registeredTools));
}

test('every MCP read tool is registered and runs through existing Engine methods', () => {
  const tools = mcpToolNames();
  for (const [tool, methods] of Object.entries(MCP_READS)) {
    expect(tools.has(tool)).toBe(true);
    for (const method of methods) {
      expect(method in engineSchemas).toBe(true);
    }
  }
});

test('every Engine method is claimed by the CLI or MCP surface', () => {
  const claimed = new Set([...Object.values(MCP_READS).flat(), ...Object.keys(OTHER_SURFACE)]);
  expect(Object.keys(engineSchemas).filter((method) => !claimed.has(method))).toEqual([]);
});

test('console methods are namespaced and registered on neither the CLI nor MCP', () => {
  const tools = mcpToolNames();
  const claimed = new Set(Object.values(MCP_READS).flat());
  for (const method of Object.keys(consoleSchemas)) {
    // `console.overview` shares its name with the `overview` tool; the tool runs the project Engine's `overview`.
    expect(method in engineSchemas && method !== 'overview').toBe(false);
    expect(claimed.has(`console.${method}`)).toBe(false);
    if (method !== 'overview') {
      expect(tools.has(method)).toBe(false);
      expect(method in COMMAND_HELP).toBe(false);
    }
  }
  expect(tools.has('console')).toBe(false);
  expect('console' in COMMAND_HELP).toBe(false);
});
