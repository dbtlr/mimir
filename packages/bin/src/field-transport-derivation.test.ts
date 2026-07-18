import { expect, test } from 'bun:test';

import { z } from 'zod';

import { updateFieldFlags } from './cli/mutations';
import { SPEC_UPDATE_FIELDS } from './core';
import type { SpecUpdateField, UpdateFieldKey } from './core';
import { nodeBodyFields } from './http/server';
import { buildMcpServer, fieldInputShape } from './mcp/server';
import { inertStore } from './testing/store';

/**
 * The three field transport surfaces derive from one field spec (ADR 0025,
 * MMR-315): the CLI flag template, the MCP `update`/`create` zod fragments, and
 * the HTTP body allow-lists. No transport hand-lists the data-plane field keys,
 * and a new spec entry with an existing kind surfaces on all three with zero
 * transport edits — the property this suite pins.
 */

/** The advertised inputSchema of a registered MCP tool, as JSON Schema. */
function mcpToolSchema(name: string): Record<string, unknown> & {
  properties?: Record<string, unknown>;
} {
  const server = buildMcpServer(inertStore(), '0.0.0-test');
  // The SDK exposes no public accessor for its registered schemas — the one cast
  // the server's own guard already uses (see `guardInputSchemaVoice`).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const internals = server as unknown as {
    _registeredTools: Record<string, { inputSchema?: z.ZodType }>;
  };
  // oxlint-disable-next-line eslint/no-underscore-dangle
  const schema = internals._registeredTools[name]?.inputSchema;
  if (schema === undefined) {
    return {};
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return z.toJSONSchema(schema) as { properties?: Record<string, unknown> };
}

/** The advertised inputSchema property names of a registered MCP tool. */
function mcpToolProps(name: string): string[] {
  return Object.keys(mcpToolSchema(name).properties ?? {});
}

test('every generic-update spec field surfaces on all three transports', () => {
  const updateProps = new Set(mcpToolProps('update'));
  const createProps = new Set(mcpToolProps('create'));
  const patchBody = new Set(nodeBodyFields());

  expect(SPEC_UPDATE_FIELDS.length).toBeGreaterThan(0);
  for (const field of SPEC_UPDATE_FIELDS) {
    // MCP: the camelCase arg name is a property of both write schemas.
    expect(updateProps.has(field.update)).toBe(true);
    expect(createProps.has(field.update)).toBe(true);
    // HTTP: the snake_case key is an accepted body field.
    expect(patchBody.has(field.key)).toBe(true);
    // CLI: the field renders at least one flag.
    expect(updateFieldFlags(field.update).length).toBeGreaterThan(0);
  }
});

test('golden: the advertised update/create schemas are pinned exactly', () => {
  // The full registered surface, pinned as data — a re-hand-listed arg beside
  // the derived fragment (a duplicate key overriding its kind fragment, or an
  // extra property) fails here even though the set-membership sweep above would
  // stay green. Property order is advertised alphabetical (`sortedShape`).
  const enums = {
    priority: { enum: ['p0', 'p1', 'p2', 'p3'], type: 'string' },
    size: { enum: ['small', 'medium', 'large'], type: 'string' },
  };
  const update = mcpToolSchema('update');
  expect(update).toEqual({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    additionalProperties: false,
    properties: {
      description: { type: 'string' },
      externalRef: { type: 'string' },
      id: { type: 'string' },
      kind: { enum: ['idea', 'bug', 'feature'], type: 'string' },
      openEnded: { type: 'boolean' },
      ...enums,
      summary: { type: 'string' },
      target: { type: 'string' },
      title: { type: 'string' },
      upstream: { type: 'string' },
    },
    required: ['id'],
    type: 'object',
  });
  const create = mcpToolSchema('create');
  expect(create).toEqual({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    additionalProperties: false,
    properties: {
      description: { type: 'string' },
      externalRef: { type: 'string' },
      key: { type: 'string' },
      name: { type: 'string' },
      openEnded: { type: 'boolean' },
      parent: { type: 'string' },
      ...enums,
      summary: { type: 'string' },
      tags: { items: { type: 'string' }, type: 'array' },
      target: { type: 'string' },
      title: { type: 'string' },
      type: { enum: ['project', 'initiative', 'phase', 'task'], type: 'string' },
      upstream: { type: 'string' },
    },
    required: ['type'],
    type: 'object',
  });
  // Byte-identity needs order too — toEqual is order-blind.
  for (const schema of [update, create]) {
    const keys = Object.keys(schema.properties ?? {});
    expect(keys).toEqual(keys.toSorted());
  }
});

test('the HTTP body allow-list is exactly the spec keys — no hand-listed extras', () => {
  // The data-plane portion is precisely the spec's update-field keys (structural
  // title/description/type/parent/tags are the bespoke identity plane, tested
  // via the routes). A drift here means a transport re-hand-listed a field.
  expect(nodeBodyFields().toSorted()).toEqual(SPEC_UPDATE_FIELDS.map((f) => f.key).toSorted());
});

test('CLI flag spelling: default is --<kebab-key>, overrides diverge', () => {
  // Default derivation from the field model.
  expect(updateFieldFlags('priority' as UpdateFieldKey)).toEqual([['priority', '--priority']]);
  expect(updateFieldFlags('summary' as UpdateFieldKey)).toEqual([['summary', '--summary']]);
  // Overrides — the only hand-held spellings.
  expect(updateFieldFlags('externalRef' as UpdateFieldKey)).toEqual([['ref', '--ref']]);
  expect(updateFieldFlags('description' as UpdateFieldKey)).toEqual([['desc', '--desc']]);
  expect(updateFieldFlags('openEnded' as UpdateFieldKey)).toEqual([
    ['open-ended', '--open-ended'],
    ['not-open-ended', '--not-open-ended'],
  ]);
});

test('the transport builders are pure over the field list: a new entry propagates', () => {
  // A synthetic data-plane field, as if a new FIELD_FACTS entry — an existing
  // kind, so no code binding changes. This exercises the builders directly, so
  // it proves they derive from their field-list argument, not that the live
  // transports call them — the registration wiring for the real set is what
  // the surface sweep and the schema golden above pin.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const synthetic = {
    key: 'synthetic_field',
    kind: 'string',
    update: 'syntheticField',
  } as unknown as SpecUpdateField;
  const augmented = [...SPEC_UPDATE_FIELDS, synthetic];

  // MCP: the derived fragment carries the new arg.
  expect(Object.keys(fieldInputShape(augmented))).toContain('syntheticField');
  // HTTP: the derived allow-list carries the new key.
  expect(nodeBodyFields(augmented)).toContain('synthetic_field');
  // CLI: the field renders a derived default flag with no override entry.
  expect(updateFieldFlags('syntheticField' as UpdateFieldKey)).toEqual([
    ['synthetic-field', '--synthetic-field'],
  ]);
});
