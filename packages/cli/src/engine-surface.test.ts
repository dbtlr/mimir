import { afterAll, beforeAll, expect, test } from 'bun:test';

import { consoleSchemas, engineSchemas, UNIFORM_VERBS } from '@mimir/contract';

import { application } from './application';
import { parityBoard } from './testing/fixture';
import type { ParityBoard } from './testing/fixture';
import { loomMcpSession } from './testing/mcp';

/**
 * Every Engine method is claimed by a CLI command or MCP tool that runs through
 * it, and the console's `console.*` methods stay off both surfaces (ADR 0034,
 * decisions 6 and the 2026-10-18 refinements). The commands are read from the
 * Application's graph and the tools from a live MCP session, so a command added
 * without its Engine method named here fails.
 */

/** One CLI command and/or MCP tool, and the Engine method(s) it runs through. */
type Surface = {
  /** The command path, words joined by spaces. */
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

/** A command beneath a group, whose MCP tool joins the path with `_`. */
const nested = (path: string, ...methods: string[]): Surface => ({
  cli: path,
  mcp: path.replaceAll(' ', '_'),
  methods,
});

/** The uniform verbs that also answer a seed id, through a seed-typed Engine method. */
const SEED_VARIANT: Readonly<Record<string, readonly string[]>> = {
  park: ['seedPark'],
  unpark: ['seedUnpark'],
};

const SURFACES: readonly Surface[] = [
  // Reads.
  same('artifacts'),
  same('get', 'getNode', 'getArtifact', 'getSeed'),
  same('list'),
  same('next'),
  same('overview'),
  same('projects'),
  // The remote lookup has no command: `mimir bind` and the auto-bind (MMR-544) are its first callers.
  { methods: ['projectsByRemote'] },
  same('search'),
  same('seeds'),
  same('status'),
  same('tree'),
  nested('scratch get', 'scratchGet'),
  nested('scratch list', 'scratchList'),
  // Node writes. `update` also patches a project key, an artifact, or a seed id, and `park` and
  // `unpark` also move a seed, each through the seed- or project-typed method.
  same('annotate'),
  same('attach'),
  nested('create project', 'create'),
  nested('create initiative', 'create'),
  nested('create phase', 'create'),
  nested('create task', 'create'),
  same('depend'),
  same('groom'),
  same('move'),
  same('reorder'),
  same('tag'),
  same('undepend'),
  same('untag'),
  same('update', 'update', 'updateProject', 'updateArtifact', 'seedUpdate'),
  // The uniform verbs, one CLI command and MCP tool each.
  ...UNIFORM_VERBS.map((verb) => same(verb, verb, ...(SEED_VARIANT[verb] ?? []))),
  // Seed writes.
  { cli: 'seed', mcp: 'seed', methods: ['seedCreate'] },
  same('promote', 'seedPromote'),
  same('reject', 'seedReject'),
  same('resolve', 'seedResolve'),
  same('triage'),
  // Scratchpad writes. `scratch agenda` takes the action as an argument.
  nested('scratch agenda', 'scratchAgendaAdd', 'scratchAgendaComplete', 'scratchAgendaSupersede'),
  nested('scratch checkpoint', 'scratchCheckpoint'),
  nested('scratch create', 'scratchCreate'),
  nested('scratch discard', 'scratchDiscard'),
  nested('scratch freeze', 'scratchFreeze'),
  nested('scratch update', 'scratchUpdate'),
];

type Node = ReturnType<typeof application.inspect>['root'];

/** The path of every visible command that has an action. */
function commandPaths(node: Node, path: readonly string[] = []): string[] {
  const own = node.hasAction && !node.hidden && path.length > 0 ? [path.join(' ')] : [];
  return [
    ...own,
    ...node.children.flatMap((child) => commandPaths(child, [...path, child.name ?? ''])),
  ];
}

let board: ParityBoard;
let tools: Set<string>;
const commands = new Set(commandPaths(application.inspect().root));

beforeAll(async () => {
  board = await parityBoard();
  const session = loomMcpSession(board.app('MMR'));
  tools = new Set(await session.tools());
  await session.close();
});

afterAll(async () => {
  await board.close();
});

test('every claimed CLI command and MCP tool is registered and runs through existing Engine methods', () => {
  for (const { cli, mcp, methods } of SURFACES) {
    if (cli !== undefined) {
      expect(commands.has(cli), cli).toBe(true);
    }
    if (mcp !== undefined) {
      expect(tools.has(mcp), mcp).toBe(true);
    }
    for (const method of methods) {
      expect(method in engineSchemas, method).toBe(true);
    }
  }
});

test('every Engine method is claimed by the CLI or MCP surface', () => {
  const claimed = new Set(SURFACES.flatMap(({ methods }) => methods));
  expect(Object.keys(engineSchemas).filter((method) => !claimed.has(method))).toEqual([]);
});

/** Spelling-blind form, so `node_work`, `nodeWork`, and `node-work` compare equal. */
const flatName = (name: string): string => name.replaceAll(/[^a-z]/gi, '').toLowerCase();

/** Console views whose name a project-scoped flat method also carries. */
const SHARED_CONSOLE_NAMES: ReadonlySet<string> = new Set(['overview', 'search']);

test('console methods are namespaced and registered on neither the CLI nor MCP', () => {
  const toolNames = new Set([...tools].map(flatName));
  const commandNames = new Set([...commands].map(flatName));
  for (const method of Object.keys(consoleSchemas)) {
    // `console.overview` and `console.search` share their names with the
    // `overview` and `search` tools; those run the project-scoped flat methods.
    const shared = SHARED_CONSOLE_NAMES.has(method);
    expect(method in engineSchemas && !shared).toBe(false);
    if (!shared) {
      // Any spelling of the method, bare or `console`-prefixed, would be a console view leaking out.
      for (const spelling of [flatName(method), `console${flatName(method)}`]) {
        expect(toolNames.has(spelling)).toBe(false);
        expect(commandNames.has(spelling)).toBe(false);
      }
    }
  }
  expect(tools.has('console')).toBe(false);
  expect(commands.has('console')).toBe(false);
});
