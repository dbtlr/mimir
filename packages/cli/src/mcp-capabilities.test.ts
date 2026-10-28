import { afterAll, beforeAll, expect, test } from 'bun:test';

import { ADDED, NOT_CARRIED, TOOL_COVERAGE } from './parity/mcp-capabilities';
import { parityBoard } from './testing/fixture';
import type { ParityBoard } from './testing/fixture';
import { loomMcpSession, oldMcpSession } from './testing/mcp';
import type { ToolSchema } from './testing/mcp';

/**
 * MCP capability parity (ADR 0037): the old server's every tool is covered by
 * a Loom tool the checked-in map names, and the map names nothing that does
 * not exist. The machine-local and installer commands stay off MCP.
 */
let board: ParityBoard;
let oldTools: string[];
let loomTools: string[];
const oldSchemas = new Map<string, ToolSchema>();
const loomSchemas = new Map<string, ToolSchema>();

beforeAll(async () => {
  board = await parityBoard();
  const old = await oldMcpSession(board.store);
  oldTools = await old.tools();
  for (const tool of oldTools) {
    oldSchemas.set(tool, await old.schema(tool));
  }
  await old.close();
  const loom = loomMcpSession(board.app('MMR'));
  loomTools = await loom.tools();
  for (const tool of loomTools) {
    loomSchemas.set(tool, await loom.schema(tool));
  }
  await loom.close();
});

afterAll(async () => {
  await board.close();
});

test('every tool of the old server has an entry in the capability map', () => {
  expect(oldTools.filter((tool) => TOOL_COVERAGE[tool] === undefined)).toEqual([]);
});

test('the capability map names no tool the old server lacks', () => {
  expect(Object.keys(TOOL_COVERAGE).filter((tool) => !oldTools.includes(tool))).toEqual([]);
});

test('every Loom tool the map names exists', () => {
  const named = Object.values(TOOL_COVERAGE).flatMap((coverage) => coverage.loom);
  expect(named.filter((tool) => !loomTools.includes(tool))).toEqual([]);
});

test('every Loom tool covers an old tool or is listed as added', () => {
  const named = new Set([
    ...Object.values(TOOL_COVERAGE).flatMap((coverage) => coverage.loom),
    ...ADDED,
  ]);
  expect(loomTools.filter((tool) => !named.has(tool))).toEqual([]);
  expect(ADDED.filter((tool) => !loomTools.includes(tool))).toEqual([]);
});

test('every not-carried entry states what and why', () => {
  for (const entry of NOT_CARRIED) {
    expect(entry.what.length).toBeGreaterThan(0);
    expect(entry.reason.length).toBeGreaterThan(0);
  }
});

test('the machine-local and installer commands are not tools', () => {
  const machine = [
    'bind',
    'doctor',
    'pair',
    'store',
    'version',
    'skills',
    'self_update',
    'mcp',
    'installation_protocol',
    'installation_install',
  ];
  expect(loomTools.filter((tool) => machine.some((name) => tool.startsWith(name)))).toEqual([]);
});

/** A JSON Schema type with numbers read as one. */
const kindOf = (schema: { type?: string } | undefined): string | undefined =>
  schema?.type === 'integer' ? 'number' : schema?.type;

/**
 * Every input of an old tool that the mapped Loom tools do not take under the
 * same name and type, as `old key` -> why. A key a Loom tool takes with the
 * same type needs no record; a renamed, retyped, or dropped one must be named
 * in the entry's `inputs`, so a changed input cannot slip by unrecorded.
 */
function unrecordedInputs(tool: string): string[] {
  const coverage = TOOL_COVERAGE[tool];
  const old = oldSchemas.get(tool);
  if (coverage === undefined || old === undefined) {
    return [];
  }
  const targets = coverage.loom.map((name) => loomSchemas.get(name)?.properties ?? {});
  return Object.entries(old.properties).flatMap(([key, schema]) => {
    // Both kinds read undefined for an absent key and an untyped schema, so presence counts too.
    const same = targets.some((props) => key in props && kindOf(props[key]) === kindOf(schema));
    return same || key in (coverage.inputs ?? {}) ? [] : [key];
  });
}

test('every renamed, retyped, or dropped input of an old tool is recorded in its entry', () => {
  const missing = Object.keys(TOOL_COVERAGE).flatMap((tool) =>
    unrecordedInputs(tool).map((key) => `${tool}.${key}`),
  );
  expect(missing).toEqual([]);
});

test('every recorded input names a real old input and, when renamed, a real Loom input', () => {
  const wrong: string[] = [];
  for (const [tool, coverage] of Object.entries(TOOL_COVERAGE)) {
    const old = oldSchemas.get(tool)?.properties ?? {};
    const targets = coverage.loom.map((name) => loomSchemas.get(name)?.properties ?? {});
    for (const [key, now] of Object.entries(coverage.inputs ?? {})) {
      if (!(key in old)) {
        wrong.push(`${tool}: ${key} is not an input of the old tool`);
      } else if (now !== null && !targets.some((props) => now in props)) {
        wrong.push(`${tool}: ${key} -> ${now} is not an input of ${coverage.loom.join(', ')}`);
      } else if (
        now === key &&
        targets.some((props) => key in props && kindOf(props[key]) === kindOf(old[key]))
      ) {
        wrong.push(`${tool}: ${key} is recorded as retyped but is not`);
      }
    }
  }
  expect(wrong).toEqual([]);
});

test('an input change left out of an entry fails the check', () => {
  const trimmed = { ...TOOL_COVERAGE.annotate, inputs: {} };
  const saved = TOOL_COVERAGE.annotate;
  Reflect.set(TOOL_COVERAGE, 'annotate', trimmed);
  try {
    expect(unrecordedInputs('annotate')).toEqual(['content']);
  } finally {
    Reflect.set(TOOL_COVERAGE, 'annotate', saved);
  }
});
