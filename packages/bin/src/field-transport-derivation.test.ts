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

/** The advertised inputSchema property names of a registered MCP tool. */
function mcpToolProps(name: string): string[] {
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
    return [];
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const json = z.toJSONSchema(schema) as { properties?: Record<string, unknown> };
  return Object.keys(json.properties ?? {});
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

test('a new spec entry with an existing kind reaches all three surfaces, zero transport edits', () => {
  // A synthetic data-plane field, as if a new FIELD_FACTS entry — an existing
  // kind, so no code binding changes. The transport builders are pure over the
  // field list, so feeding it the augmented set proves propagation without
  // touching CLI/MCP/HTTP code.
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
