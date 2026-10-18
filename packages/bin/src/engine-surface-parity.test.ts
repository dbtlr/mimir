import { expect, test } from 'bun:test';

import { consoleSchemas, engineSchemas, UNIFORM_VERBS } from '@mimir/contract';
import { inertStore } from '@mimir/core/testing';

import { COMMAND_HELP } from './cli/help';
import { buildMcpServer } from './mcp/server';

/**
 * Every Engine method is claimed by a CLI command or MCP tool that runs through
 * it, and the console's `console.*` methods stay off both surfaces (ADR 0034,
 * decisions 6 and the 2026-10-18 refinements).
 */

/** One CLI command and/or MCP tool, and the Engine method(s) it runs through. */
type Surface = {
  readonly cli?: string;
  readonly mcp?: string;
  readonly methods: readonly string[];
};

/** A surface whose CLI command and MCP tool share a name and run the same method. */
const same = (name: string, ...methods: string[]): Surface => ({
  cli: name,
  mcp: name,
  methods: methods.length > 0 ? methods : [name],
});

/** The uniform verbs that also answer a seed id, through a seed-typed Engine method. */
const SEED_VARIANT: Readonly<Record<string, readonly string[]>> = {
  park: ['seedPark'],
  unpark: ['seedUnpark'],
};

const SURFACES: readonly Surface[] = [
  // Reads.
  same('artifacts'),
  { cli: 'get', mcp: 'get', methods: ['getNode', 'getArtifact', 'getSeed'] },
  { mcp: 'get_seed', methods: ['getSeed'] },
  same('list'),
  same('next'),
  same('overview'),
  same('projects'),
  // The remote lookup has no command yet: `mimir bind` and the auto-bind (MMR-544) are its first callers.
  { methods: ['projectsByRemote'] },
  same('search'),
  { cli: 'seeds', mcp: 'seeds', methods: ['seeds'] },
  same('status'),
  { cli: 'tree', methods: ['tree'] },
  { cli: 'scratch get', mcp: 'scratch_get', methods: ['scratchGet'] },
  { cli: 'scratch list', mcp: 'scratch_list', methods: ['scratchList'] },
  // Node writes. `update` also patches a project key or a seed id, and `park` and
  // `unpark` also move a seed, each through the seed- or project-typed method.
  same('annotate'),
  same('attach'),
  same('create'),
  same('depend'),
  same('groom'),
  same('move'),
  same('reorder'),
  same('tag'),
  same('undepend'),
  same('untag'),
  same('update', 'update', 'updateProject', 'seedUpdate'),
  // The uniform verbs, one CLI command and MCP tool each.
  ...UNIFORM_VERBS.map((verb) => same(verb, verb, ...(SEED_VARIANT[verb] ?? []))),
  // Seed writes.
  { cli: 'seed', mcp: 'seed', methods: ['seedCreate'] },
  same('promote', 'seedPromote'),
  same('reject', 'seedReject'),
  same('resolve', 'seedResolve'),
  same('triage'),
  // Scratchpad writes.
  { cli: 'scratch agenda add', mcp: 'scratch_agenda_add', methods: ['scratchAgendaAdd'] },
  {
    cli: 'scratch agenda complete',
    mcp: 'scratch_agenda_complete',
    methods: ['scratchAgendaComplete'],
  },
  {
    cli: 'scratch agenda supersede',
    mcp: 'scratch_agenda_supersede',
    methods: ['scratchAgendaSupersede'],
  },
  { cli: 'scratch checkpoint', mcp: 'scratch_checkpoint', methods: ['scratchCheckpoint'] },
  { cli: 'scratch create', mcp: 'scratch_create', methods: ['scratchCreate'] },
  { cli: 'scratch discard', mcp: 'scratch_discard', methods: ['scratchDiscard'] },
  { cli: 'scratch freeze', mcp: 'scratch_freeze', methods: ['scratchFreeze'] },
  { cli: 'scratch update', mcp: 'scratch_update', methods: ['scratchUpdate'] },
];

function mcpToolNames(): Set<string> {
  const server = buildMcpServer(inertStore(), '0.0.0-test');
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const internals = server as unknown as { _registeredTools: Record<string, unknown> };
  // oxlint-disable-next-line eslint/no-underscore-dangle
  return new Set(Object.keys(internals._registeredTools));
}

test('every claimed CLI command and MCP tool is registered and runs through existing Engine methods', () => {
  const tools = mcpToolNames();
  for (const { cli, mcp, methods } of SURFACES) {
    if (cli !== undefined) {
      expect(cli in COMMAND_HELP).toBe(true);
    }
    if (mcp !== undefined) {
      expect(tools.has(mcp)).toBe(true);
    }
    for (const method of methods) {
      expect(method in engineSchemas).toBe(true);
    }
  }
});

test('every Engine method is claimed by the CLI or MCP surface', () => {
  const claimed = new Set(SURFACES.flatMap(({ methods }) => methods));
  expect(Object.keys(engineSchemas).filter((method) => !claimed.has(method))).toEqual([]);
});

/** Spelling-blind form, so `node_work`, `nodeWork`, and `node-work` compare equal. */
const flatName = (name: string): string => name.replaceAll(/[^a-z]/gi, '').toLowerCase();

test('console methods are namespaced and registered on neither the CLI nor MCP', () => {
  const tools = mcpToolNames();
  const toolNames = new Set([...tools].map(flatName));
  const commandNames = new Set(Object.keys(COMMAND_HELP).map(flatName));
  for (const method of Object.keys(consoleSchemas)) {
    // `console.overview` shares its name with the `overview` tool; the tool runs the project Engine's `overview`.
    expect(method in engineSchemas && method !== 'overview').toBe(false);
    if (method !== 'overview') {
      // Any spelling of the method, bare or `console`-prefixed, would be a console view leaking out.
      for (const spelling of [flatName(method), `console${flatName(method)}`]) {
        expect(toolNames.has(spelling)).toBe(false);
        expect(commandNames.has(spelling)).toBe(false);
      }
    }
  }
  expect(tools.has('console')).toBe(false);
  expect('console' in COMMAND_HELP).toBe(false);
});
