import { expect, test } from 'bun:test';

import { OP_FACTS, UNIFORM_VERBS } from '@mimir/contract';
import type { OpFact } from '@mimir/contract';
import { z } from 'zod';

import { COMMAND_HELP, TERSE_HELP, uniformArgSpec, uniformSummary } from './cli/help';
import { OP_SPECS } from './core';
import { uniformRoutes } from './http/server';
import { buildMcpServer, uniformToolDescription, uniformToolSchema } from './mcp/server';
import { inertStore } from './testing/store';

/**
 * The three transport surfaces for the twelve uniform verbs derive from one
 * operation registry (ADR 0025, MMR-316): the CLI's one dispatch arm + its help
 * (terse rows + per-command descriptors), the MCP tool registrations, and the
 * HTTP action routes. No transport hand-lists the verbs, and a new registry
 * entry surfaces on all three with zero transport edits — the property this
 * suite pins, the verb analogue of the field-transport derivation pair.
 */

/** The registered tool names of a freshly-built MCP server (its `_registeredTools`
 * map — the one internals cast the field derivation test already uses). */
function mcpToolNames(): Set<string> {
  const server = buildMcpServer(inertStore(), '0.0.0-test');
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const internals = server as unknown as {
    _registeredTools: Record<string, { inputSchema?: z.ZodType }>;
  };
  // oxlint-disable-next-line eslint/no-underscore-dangle
  return new Set(Object.keys(internals._registeredTools));
}

/** The advertised JSON-Schema property names of a registered MCP tool. */
function mcpToolProps(name: string): string[] {
  const server = buildMcpServer(inertStore(), '0.0.0-test');
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const internals = server as unknown as {
    _registeredTools: Record<string, { inputSchema?: z.ZodType }>;
  };
  // oxlint-disable-next-line eslint/no-underscore-dangle
  const schema = internals._registeredTools[name]?.inputSchema;
  if (schema === undefined) {
    return [];
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const json = z.toJSONSchema(schema) as { properties?: Record<string, unknown> };
  return Object.keys(json.properties ?? {});
}

test('the registry advertises exactly the twelve uniform verbs', () => {
  expect(OP_SPECS.map((s) => s.verb)).toEqual([...UNIFORM_VERBS]);
  expect(OP_SPECS).toHaveLength(12);
});

test('every uniform verb surfaces on all three transports', () => {
  const tools = mcpToolNames();
  const routes = new Set(Object.keys(uniformRoutes(inertStore())));
  for (const spec of OP_SPECS) {
    // CLI: a valid command with a per-command descriptor and a terse-help row.
    expect(COMMAND_HELP[spec.verb]).toBeDefined();
    expect(TERSE_HELP.includes(`    ${spec.verb} `)).toBe(true);
    // MCP: a registered tool named for the verb, carrying its subject id arg.
    expect(tools.has(spec.verb)).toBe(true);
    const props = new Set(mcpToolProps(spec.verb));
    expect(props.has(spec.subject === 'project' ? 'key' : 'id')).toBe(true);
    expect(props.has('reason')).toBe(spec.reason === 'optional');
    // HTTP: an action route on the subject's URL family.
    const path =
      spec.subject === 'project'
        ? `/api/projects/:key/${spec.verb}`
        : `/api/nodes/:id/${spec.verb}`;
    expect(routes.has(path)).toBe(true);
  }
});

test('golden: the derived rendered text is pinned exactly (CLI + MCP)', () => {
  // Every uniform verb's terse-row summary, command-help usage/summary, and MCP
  // description as data — a template drift or a hand-re-authored string fails
  // here. This is the golden pin for the rendered-text derivation (MMR-316).
  const rows = OP_SPECS.map((s) => `${s.verb}|${uniformArgSpec(s)}|${uniformSummary(s)}`);
  expect(rows).toEqual([
    'start|<id>|begin a task (todo → in_progress)',
    'submit|<id>|submit for review (in_progress → under_review)',
    'return|<id> [reason]|send back for changes (under_review → in_progress)',
    'done|<id>|complete a task (approves a review)',
    'abandon|<id> [reason]|abandon a task (kept, not deleted)',
    'reopen|<id> [reason]|reopen a terminal task (done/abandoned → in_progress)',
    'park|<id> [reason]|put a task on hold',
    'unpark|<id>|clear the parked hold',
    'block|<id> [reason]|mark as externally blocked',
    'unblock|<id>|clear the blocked hold',
    'archive|<KEY> [reason]|archive a project — freeze + hide it and its subtree (reversible)',
    'unarchive|<KEY>|restore an archived project',
  ]);
  expect(OP_SPECS.map((s) => uniformToolDescription(s))).toEqual([
    'Begin a task (todo → in_progress). Echoes the updated node.',
    'Submit for review (in_progress → under_review). Echoes the updated node.',
    'Send back for changes (under_review → in_progress). Optionally records a reason on the transition. Echoes the updated node.',
    'Complete a task (approves a review). Echoes the updated node.',
    'Abandon a task (kept, not deleted). Optionally records a reason on the transition. Echoes the updated node.',
    'Reopen a terminal task (done/abandoned → in_progress). Optionally records a reason on the transition. Echoes the updated node.',
    'Put a task on hold. Optionally records a reason on the transition. Echoes the updated node.',
    'Clear the parked hold. Echoes the updated node.',
    'Mark as externally blocked. Optionally records a reason on the transition. Echoes the updated node.',
    'Clear the blocked hold. Echoes the updated node.',
    'Archive a project — freeze + hide it and its subtree (reversible). Optionally records a reason on the transition. Echoes the project.',
    'Restore an archived project. Echoes the project.',
  ]);
});

test('the transport builders are pure over the registry: a synthetic verb propagates', () => {
  // A synthetic uniform verb, as if a new OP_FACTS entry — a task subject with an
  // optional reason. This exercises the builders directly, proving they derive
  // from their spec argument, not that the live transports enumerate them (the
  // surface sweep above pins the real set's wiring).
  const fact: OpFact = {
    reason: 'optional',
    subject: 'task',
    summary: 'synthesize a task',
    transition: { axis: 'lifecycle', from: ['todo'], to: 'in_progress' },
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const synthetic = {
    ...fact,
    run: () => {
      throw new Error('synthetic run is never invoked');
    },
    verb: 'synthesize',
  } as unknown as NonNullable<Parameters<typeof uniformRoutes>[1]>[number];

  // CLI: the row synopsis + summary derive from the fact.
  expect(uniformArgSpec(fact)).toBe('<id> [reason]');
  expect(uniformSummary(fact)).toBe('synthesize a task (todo → in_progress)');
  // MCP: the schema carries the subject id arg + reason; the description composes.
  expect(Object.keys(uniformToolSchema(fact)).toSorted()).toEqual(['id', 'reason']);
  expect(uniformToolDescription(fact)).toBe(
    'Synthesize a task (todo → in_progress). Optionally records a reason on the transition. Echoes the updated node.',
  );
  // HTTP: the derived route mounts on the node family under the verb.
  expect(Object.keys(uniformRoutes(inertStore(), [synthetic]))).toEqual([
    '/api/nodes/:id/synthesize',
  ]);

  // A project subject routes to the project family and takes a `key` arg.
  const projectFact: OpFact = {
    reason: 'none',
    subject: 'project',
    summary: 'freeze a project',
    transition: { axis: 'archive', from: 'active', to: 'archived' },
  };
  expect(uniformArgSpec(projectFact)).toBe('<KEY>');
  expect(Object.keys(uniformToolSchema(projectFact))).toEqual(['key']);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const projectSpec = {
    ...projectFact,
    run: () => {
      throw new Error('synthetic run is never invoked');
    },
    verb: 'freeze',
  } as unknown as NonNullable<Parameters<typeof uniformRoutes>[1]>[number];
  expect(Object.keys(uniformRoutes(inertStore(), [projectSpec]))).toEqual([
    '/api/projects/:key/freeze',
  ]);
});

// Guard: the fact table and the ordered list agree (no missing/extra entry).
test('OP_SPECS is OP_FACTS composed in UNIFORM_VERBS order', () => {
  for (const spec of OP_SPECS) {
    expect(spec.subject).toBe(OP_FACTS[spec.verb].subject);
    expect(spec.reason).toBe(OP_FACTS[spec.verb].reason);
    expect(spec.summary).toBe(OP_FACTS[spec.verb].summary);
  }
});
