import { expect, test } from 'bun:test';

import { OP_FACTS, UNIFORM_VERBS } from '@mimir/contract';
import type { OpFact } from '@mimir/contract';
import { assertOpFields, OP_SPECS } from '@mimir/core';
import { inertStore } from '@mimir/core/testing';
import { z } from 'zod';

import {
  COMMAND_HELP,
  TERSE_HELP,
  uniformArgSpec,
  uniformFlagSpec,
  uniformSummary,
} from './cli/help';
import { buildMcpServer, uniformToolDescription, uniformToolSchema } from './mcp/server';

/**
 * The transport surfaces for the twelve uniform verbs derive from one
 * operation registry (ADR 0025, MMR-316): the CLI's one dispatch arm + its help
 * (terse rows + per-command descriptors) and the MCP tool registrations. No
 * transport hand-lists the verbs, and a new registry
 * entry surfaces on both with zero transport edits — the property this
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

test('the registry advertises exactly the fourteen uniform verbs', () => {
  expect(OP_SPECS.map((s) => s.verb)).toEqual([...UNIFORM_VERBS]);
  expect(OP_SPECS).toHaveLength(14);
});

test('every uniform verb surfaces on both transports', () => {
  const tools = mcpToolNames();
  for (const spec of OP_SPECS) {
    // CLI: a valid command with a per-command descriptor and a terse-help row.
    expect(COMMAND_HELP[spec.verb]).toBeDefined();
    expect(TERSE_HELP.includes(`    ${spec.verb} `)).toBe(true);
    // MCP: a registered tool named for the verb, carrying its subject id arg.
    expect(tools.has(spec.verb)).toBe(true);
    const props = new Set(mcpToolProps(spec.verb));
    expect(props.has(spec.subject === 'project' ? 'key' : 'id')).toBe(true);
    expect(props.has('reason')).toBe(spec.reason !== 'none');
  }
});

test('golden: the derived rendered text is pinned exactly (CLI + MCP)', () => {
  // Every uniform verb's terse-row summary, command-help usage/summary, and MCP
  // description as data — a template drift or a hand-re-authored string fails
  // here. This is the golden pin for the rendered-text derivation (MMR-316).
  const rows = OP_SPECS.map((s) => `${s.verb}|${uniformArgSpec(s)}|${uniformSummary(s)}`);
  expect(rows).toEqual([
    'queue|<id>|reserve a task for an autonomous run (todo → queued)',
    'unqueue|<id> <reason>|cancel a reservation and return the task to todo (queued → todo)',
    'start|<id>|begin a task (todo/queued → in_progress)',
    'submit|<id>|submit for review (in_progress → under_review)',
    'return|<id> [reason]|send back for changes (under_review → in_progress)',
    'done|<id>|complete a task (approves a review)',
    'abandon|<id> [reason]|abandon a task (kept, not deleted)',
    'reopen|<id> [reason]|reopen a terminal task (done/abandoned → in_progress)',
    'park|<id> [reason]|put a task on hold · also a seed (KEY-sN)',
    'unpark|<id>|clear the parked hold · also a seed (KEY-sN)',
    'block|<id> [reason]|mark as externally blocked',
    'unblock|<id>|clear the blocked hold',
    'archive|<KEY> [reason]|archive a project — freeze + hide it and its subtree (reversible)',
    'unarchive|<KEY>|restore an archived project',
  ]);
  expect(OP_SPECS.map((s) => uniformToolDescription(s))).toEqual([
    'Reserve a task for an autonomous run (todo → queued). Requires session. Echoes the updated node.',
    'Cancel a reservation and return the task to todo (queued → todo). Requires a reason recorded on the transition. Echoes the updated node.',
    'Begin a task (todo/queued → in_progress). Echoes the updated node.',
    'Submit for review (in_progress → under_review). Echoes the updated node.',
    'Send back for changes (under_review → in_progress). Optionally records a reason on the transition. Echoes the updated node.',
    'Complete a task (approves a review). Echoes the updated node.',
    'Abandon a task (kept, not deleted). Optionally records a reason on the transition. Echoes the updated node.',
    'Reopen a terminal task (done/abandoned → in_progress). Optionally records a reason on the transition. Echoes the updated node.',
    'Put a task on hold. Optionally records a reason on the transition. Echoes the updated node. A seed id (KEY-sN) is accepted too: it moves the seed between untriaged and parked and echoes the seed.',
    'Clear the parked hold. Echoes the updated node. A seed id (KEY-sN) is accepted too: it moves the seed between untriaged and parked and echoes the seed.',
    'Mark as externally blocked. Optionally records a reason on the transition. Optional on (you|others): who can clear the block (default: others when the task has an upstream, else you). Echoes the updated node.',
    'Clear the blocked hold. Echoes the updated node.',
    'Archive a project — freeze + hide it and its subtree (reversible). Optionally records a reason on the transition. Echoes the project.',
    'Restore an archived project. Echoes the project.',
  ]);
});

test('golden: the per-command arg rows are pinned exactly', () => {
  // The descriptor args derive from the subject id-kind + reason policy (the
  // shared A_ID/A_KEY/A_REASON fragments); a reworded fragment or a policy
  // drift in the projection fails here.
  const rows = OP_SPECS.map(
    (s) =>
      `${s.verb}|${(COMMAND_HELP[s.verb]?.args ?? [])
        .map(([arg, desc]) => `${arg} — ${desc}`)
        .join('; ')}`,
  );
  const id = '<id> — KEY-seq (task/phase/initiative), KEY (project), or KEY-aN (artifact)';
  const key = '<KEY> — a project key (bare KEY)';
  const reason = '[reason] — optional note recorded in the transition log';
  expect(rows).toEqual([
    `queue|${id}`,
    `unqueue|${id}; <reason> — required note recorded in the transition log`,
    `start|${id}`,
    `submit|${id}`,
    `return|${id}; ${reason}`,
    `done|${id}`,
    `abandon|${id}; ${reason}`,
    `reopen|${id}; ${reason}`,
    `park|${id}; ${reason}`,
    `unpark|${id}`,
    `block|${id}; ${reason}`,
    `unblock|${id}`,
    `archive|${key}; ${reason}`,
    `unarchive|${key}`,
  ]);
});

// ── Extra data-plane fields on a uniform verb (ADR 0026, MMR-320) ────────────
// One verb (`start`) declares fields it records at its transition. The fact is
// optional, so the OTHER eleven must render byte-identically to before it
// existed — these pins are the regression fence around that claim.

test('golden: only block declares a choice argument, and only start declares data-plane fields', () => {
  expect(OP_SPECS.flatMap((s) => (s.choice === undefined ? [] : [s.verb]))).toEqual(['block']);
  expect(OP_FACTS.block.choice.name).toBe('on');
  expect(OP_FACTS.block.choice.values).toEqual(['you', 'others']);
});

test('golden: queue and start declare extra data-plane fields', () => {
  expect(OP_SPECS.flatMap((s) => (s.fields === undefined ? [] : [s.verb]))).toEqual([
    'queue',
    'start',
  ]);
  expect(OP_FACTS.start.fields).toEqual([
    'branch',
    'harness',
    'host',
    'session',
    'worker_harness',
    'worker_session',
  ]);
});

test('golden: the advertised MCP arg names are pinned per verb', () => {
  // Only `start` gained args; every other verb advertises exactly its subject id
  // (+ reason where its policy allows one), in advertised alphabetical order.
  expect(OP_SPECS.map((s) => `${s.verb}|${mcpToolProps(s.verb).join(',')}`)).toEqual([
    'queue|branch,harness,host,id,session',
    'unqueue|id,reason',
    'start|branch,harness,host,id,session,workerHarness,workerSession',
    'submit|id',
    'return|id,reason',
    'done|id',
    'abandon|id,reason',
    'reopen|id,reason',
    'park|id,reason',
    'unpark|id',
    'block|id,on,reason',
    'unblock|id',
    'archive|key,reason',
    'unarchive|key',
  ]);
});

test('golden: the CLI usage lines and flag rows are pinned per verb', () => {
  // The eleven keep a bare `mimir <verb> <subject> [reason?]` usage and NO flags
  // key at all; `start` appends its derived flag grammar.
  expect(OP_SPECS.map((s) => `${s.verb}|${COMMAND_HELP[s.verb]?.usage ?? ''}`)).toEqual([
    'queue|mimir queue <id> [--branch <text>] [--harness <text>] [--host <text>] --session <text>',
    'unqueue|mimir unqueue <id> <reason>',
    'start|mimir start <id> [--branch <text>] [--harness <text>] [--host <text>] [--session <text>] [--worker-harness <text>] [--worker-session <text>]',
    'submit|mimir submit <id>',
    'return|mimir return <id> [reason]',
    'done|mimir done <id>',
    'abandon|mimir abandon <id> [reason]',
    'reopen|mimir reopen <id> [reason]',
    'park|mimir park <id> [reason]',
    'unpark|mimir unpark <id>',
    'block|mimir block <id> [reason] [--on <you|others>]',
    'unblock|mimir unblock <id>',
    'archive|mimir archive <KEY> [reason]',
    'unarchive|mimir unarchive <KEY>',
  ]);
  for (const spec of OP_SPECS) {
    expect(COMMAND_HELP[spec.verb]?.flags === undefined).toBe(
      spec.verb !== 'start' && spec.verb !== 'queue' && spec.verb !== 'block',
    );
  }
  expect(COMMAND_HELP.block?.flags).toEqual([
    [
      '--on <you|others>',
      'who can clear the block (default: others when the task has an upstream, else you)',
    ],
  ]);
  expect(COMMAND_HELP.start?.flags).toEqual([
    ['--branch', 'the branch the work lives on'],
    ['--harness', 'the main conversation or workflow harness'],
    ['--host', 'the machine the work is happening on'],
    ['--session', 'the main conversation or workflow session'],
    ['--worker-harness', 'the distinct whole-task owner harness'],
    ['--worker-session', 'the distinct whole-task owner session'],
  ]);
});

test('the registry refuses a choice argument on a project subject', () => {
  const projectFact: OpFact = {
    choice: { name: 'on', summary: 'who', values: ['you', 'others'] },
    reason: 'none',
    subject: 'project',
    summary: 'freeze a project',
    transition: { axis: 'archive', from: 'active', to: 'archived' },
  };
  expect(() => assertOpFields('freeze', projectFact)).toThrow(
    /declares a choice argument on a project subject/,
  );
  expect(() => assertOpFields('claim', { ...projectFact, subject: 'task' })).not.toThrow();
});

test('a choice argument surfaces as a closed enum on MCP, from the fact alone', () => {
  const fact: OpFact = {
    choice: { name: 'who', summary: 'whose move it is', values: ['me', 'them'] },
    reason: 'none',
    subject: 'task',
    summary: 'hand off a task',
    transition: { axis: 'lifecycle', from: ['todo'], to: 'in_progress' },
  };
  expect(uniformFlagSpec(fact)).toBe(' [--who <me|them>]');
  expect(Object.keys(uniformToolSchema(fact)).toSorted()).toEqual(['id', 'who']);
  expect(uniformToolDescription(fact)).toBe(
    'Hand off a task (todo → in_progress). Optional who (me|them): whose move it is. Echoes the updated node.',
  );
  const json = z.toJSONSchema(z.object(uniformToolSchema(fact)));
  expect(json.properties?.who).toMatchObject({ enum: ['me', 'them'] });
});

test('the registry refuses extra data-plane fields on a project subject', () => {
  // A project verb's `run` returns a Project row, and every transport's project
  // arm has nowhere to route a field patch — so declaring one would be advertised
  // and silently dropped. Exercised through the same synthetic-fact pattern the
  // builders use, since the live table can never reach the branch.
  const projectFact: OpFact = {
    fields: ['host'],
    reason: 'none',
    subject: 'project',
    summary: 'freeze a project',
    transition: { axis: 'archive', from: 'active', to: 'archived' },
  };
  expect(() => assertOpFields('freeze', projectFact)).toThrow(
    /declares data-plane fields on a project subject/,
  );
  // A task subject declaring the same field is fine, and so is a project subject
  // declaring none — the guard is exactly the one combination.
  expect(() => assertOpFields('claim', { ...projectFact, subject: 'task' })).not.toThrow();
  expect(() => assertOpFields('freeze', { ...projectFact, fields: [] })).not.toThrow();
  // ...and the live registry passes it (every entry was bound at module load).
  for (const spec of OP_SPECS) {
    expect(() => assertOpFields(spec.verb, spec)).not.toThrow();
  }
});

test('a synthetic verb declaring no extra fields renders exactly as it always did', () => {
  const bare: OpFact = {
    reason: 'none',
    subject: 'task',
    summary: 'do the thing',
    transition: { axis: 'lifecycle', from: ['todo'], to: 'in_progress' },
  };
  expect(uniformFlagSpec(bare)).toBe('');
  expect(uniformArgSpec(bare)).toBe('<id>');
  expect(Object.keys(uniformToolSchema(bare))).toEqual(['id']);
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
  // CLI: the row synopsis + summary derive from the fact.
  expect(uniformArgSpec(fact)).toBe('<id> [reason]');
  expect(uniformSummary(fact)).toBe('synthesize a task (todo → in_progress)');
  // MCP: the schema carries the subject id arg + reason; the description composes.
  expect(Object.keys(uniformToolSchema(fact)).toSorted()).toEqual(['id', 'reason']);
  expect(uniformToolDescription(fact)).toBe(
    'Synthesize a task (todo → in_progress). Optionally records a reason on the transition. Echoes the updated node.',
  );

  // A project subject takes a `key` arg.
  const projectFact: OpFact = {
    reason: 'none',
    subject: 'project',
    summary: 'freeze a project',
    transition: { axis: 'archive', from: 'active', to: 'archived' },
  };
  expect(uniformArgSpec(projectFact)).toBe('<KEY>');
  expect(Object.keys(uniformToolSchema(projectFact))).toEqual(['key']);
});

// Guard: the fact table and the ordered list agree (no missing/extra entry).
test('OP_SPECS is OP_FACTS composed in UNIFORM_VERBS order', () => {
  for (const spec of OP_SPECS) {
    expect(spec.subject).toBe(OP_FACTS[spec.verb].subject);
    expect(spec.reason).toBe(OP_FACTS[spec.verb].reason);
    expect(spec.summary).toBe(OP_FACTS[spec.verb].summary);
  }
});

test('reservation MCP inputs require a session and cancellation reason', () => {
  const queue = z.object(uniformToolSchema(OP_FACTS.queue));
  const unqueue = z.object(uniformToolSchema(OP_FACTS.unqueue));
  expect(queue.safeParse({ id: 'MMR-3' }).success).toBe(false);
  expect(queue.safeParse({ id: 'MMR-3', session: ' ' }).success).toBe(false);
  expect(queue.safeParse({ id: 'MMR-3', session: 'run-1' }).success).toBe(true);
  expect(unqueue.safeParse({ id: 'MMR-3' }).success).toBe(false);
  expect(unqueue.safeParse({ id: 'MMR-3', reason: ' ' }).success).toBe(false);
  expect(unqueue.safeParse({ id: 'MMR-3', reason: 'cancelled' }).success).toBe(true);
});
