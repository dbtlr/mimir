import { expect, test } from 'bun:test';

import type { NodeType } from '@mimir/contract';

import type { DataFieldKey, DataFields } from './field-spec';
import { decodeDataFields, emitDataFields, FIELD_SPEC } from './field-spec';
import type { Node } from './model';

/**
 * The data-plane codec round-trip (ADR 0025, MMR-314). The field spec drives BOTH
 * codec directions from one declaration, so a field wired for emit but not decode
 * (or the reverse) is structurally impossible: {@link emitDataFields} and
 * {@link decodeDataFields} iterate the same {@link FIELD_SPEC}, and the full-node
 * round-trips below fail on any asymmetry. Pure over the spec — no vault or Norn
 * subprocess; the vault-level round-trip is `store.integration.test.ts`.
 */

const DATA_KEYS = Object.keys(FIELD_SPEC) as DataFieldKey[];

/** A full node with structural defaults and every data field null — the codec's
 * structural half is bespoke and irrelevant here; only the data plane is asserted. */
function baseNode(type: NodeType, over: Partial<Node>): Node {
  return {
    completed_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    description: null,
    external_ref: null,
    hold: type === 'task' ? 'none' : null,
    hold_reason: null,
    id: 'MMR-1',
    lifecycle: type === 'task' ? 'todo' : null,
    open_ended: null,
    parent_id: null,
    priority: null,
    project_id: 'MMR',
    rank: type === 'task' ? 1 : null,
    seq: 1,
    size: null,
    summary: null,
    target: null,
    title: 'A title',
    type,
    updated_at: '2026-01-02T00:00:00.000Z',
    upstream: null,
    ...over,
  };
}

/** The data-plane subset of a node — the codec's output half. */
function dataOf(node: Node): DataFields {
  return {
    external_ref: node.external_ref,
    hold: node.hold,
    hold_reason: node.hold_reason,
    lifecycle: node.lifecycle,
    open_ended: node.open_ended,
    priority: node.priority,
    size: node.size,
    summary: node.summary,
    target: node.target,
    upstream: node.upstream,
  };
}

/** Emit a node's data plane to frontmatter, then decode it back — the round trip. */
function roundTrip(node: Node): DataFields {
  const fm: Record<string, unknown> = {};
  emitDataFields(fm, node);
  return decodeDataFields(fm, node.type, node.id);
}

/** A representative non-null value per field, valid for the field's kind. */
const REPRESENTATIVE: Record<DataFieldKey, string | boolean> = {
  external_ref: 'JIRA-123',
  hold: 'blocked',
  hold_reason: 'waiting on review',
  lifecycle: 'in_progress',
  open_ended: true,
  priority: 'p1',
  size: 'medium',
  summary: 'the short lede',
  target: '2026-Q3',
  upstream: 'MMR-s6',
};

/** Every spec'd field paired with each node kind that carries it. */
const FIELD_TYPE_CASES: [DataFieldKey, NodeType][] = Object.values(FIELD_SPEC).flatMap((spec) =>
  spec.appliesTo.map((type): [DataFieldKey, NodeType] => [spec.key, type]),
);

// Per spec'd field × every applicable node kind: a node carrying that field
// survives encode→decode identically (ADR 0025 acceptance).
test.each(FIELD_TYPE_CASES)('%s set on a %s round-trips identically', (key, type) => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const over = { [key]: REPRESENTATIVE[key] } as Partial<Node>;
  const decoded = roundTrip(baseNode(type, over));
  expect(decoded[key]).toEqual(REPRESENTATIVE[key]);
});

test('a fully-populated task round-trips every data field (emit/decode symmetry)', () => {
  const node = baseNode('task', {
    external_ref: 'ABC-1',
    hold: 'parked',
    hold_reason: 'later',
    lifecycle: 'under_review',
    priority: 'p0',
    size: 'large',
    summary: 'a task lede',
    upstream: 'MMR-s9',
  });
  const decoded = roundTrip(node);
  expect(decoded).toEqual(dataOf(node));
  // The decode produces exactly the data-plane key set — no more, no less.
  expect(Object.keys(decoded).toSorted()).toEqual([...DATA_KEYS].toSorted());
});

test('a fully-populated phase round-trips summary/target/open_ended', () => {
  const node = baseNode('phase', { open_ended: true, summary: 'phase lede', target: 'Q4' });
  expect(roundTrip(node)).toEqual(dataOf(node));
});

test('an initiative round-trips summary/open_ended; task-only fields stay null', () => {
  const node = baseNode('initiative', { open_ended: false, summary: 'init lede' });
  const decoded = roundTrip(node);
  expect(decoded).toEqual(dataOf(node));
  expect(decoded.lifecycle).toBeNull();
  expect(decoded.priority).toBeNull();
});

test("a task's unset hold defaults to 'none' across the round trip (emit omits it)", () => {
  const fm: Record<string, unknown> = {};
  emitDataFields(fm, baseNode('task', { hold: 'none' }));
  expect(fm.hold).toBeUndefined();
  expect(decodeDataFields(fm, 'task', 'MMR-1').hold).toBe('none');
});

test('open_ended false round-trips as false, not absent (deliberate opt-out)', () => {
  const fm: Record<string, unknown> = {};
  emitDataFields(fm, baseNode('phase', { open_ended: false }));
  expect(fm.open_ended).toBe('false');
  expect(decodeDataFields(fm, 'phase', 'MMR-1').open_ended).toBe(false);
});

test('null/unset optional fields round-trip as null (omit-empty)', () => {
  const decoded = roundTrip(baseNode('task', {}));
  expect(decoded.priority).toBeNull();
  expect(decoded.size).toBeNull();
  expect(decoded.external_ref).toBeNull();
  expect(decoded.upstream).toBeNull();
  expect(decoded.summary).toBeNull();
});

test('a foreign priority/size nulls the field (tolerant read), unlike a foreign hold', () => {
  // priority/size use the non-throwing narrow; a foreign value reads as null.
  const tolerant = decodeDataFields(
    { lifecycle: 'todo', priority: 'p9', size: 'huge' },
    'task',
    'MMR-1',
  );
  expect(tolerant.priority).toBeNull();
  expect(tolerant.size).toBeNull();
  // hold is strict (its bad nodes are dropped upstream) — a foreign value throws.
  expect(() => decodeDataFields({ hold: 'nope', lifecycle: 'todo' }, 'task', 'MMR-1')).toThrow();
});

test('a task missing its required lifecycle is a seam invariant (never valid data)', () => {
  expect(() => decodeDataFields({}, 'task', 'MMR-1')).toThrow(/survived validation without a/);
});
