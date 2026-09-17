import { expect, test } from 'bun:test';

import { canonicalJson, canonicalSetOrder, canonicalTransitionOrder } from './export';
import type { NewTransitionRecord } from './store';

/**
 * The transfer document's three ordering rules (MMR-380): the one order the
 * transition collection is emitted in, the one order every SET is emitted in,
 * and the one key order the file is written in. Each is a decision both backends
 * read from here rather than re-deciding, so each is pinned on its own — the
 * conformance suite proves the backends USE them, not that they are right.
 */

function row(entity: { node_id?: string; project_id?: string }, at: string): NewTransitionRecord {
  return { at, from_value: null, kind: 'lifecycle', to_value: null, ...entity };
}

/** The entity each row belongs to, in the order the sort put them. */
function entities(rows: readonly NewTransitionRecord[]): string[] {
  return rows.map((r) => r.node_id ?? r.project_id ?? '');
}

test('canonicalTransitionOrder ranks projects before nodes, by key then sequence', () => {
  const ordered = canonicalTransitionOrder([
    row({ node_id: 'OPS-2' }, 'c'),
    row({ node_id: 'MMR-10' }, 'b'),
    row({ project_id: 'OPS' }, 'd'),
    row({ node_id: 'MMR-8' }, 'a'),
    row({ project_id: 'MMR' }, 'e'),
  ]);
  // MMR-8 before MMR-10: the sequence is compared as a NUMBER, not as text.
  expect(entities(ordered)).toEqual(['MMR', 'OPS', 'MMR-8', 'MMR-10', 'OPS-2']);
});

test('canonicalTransitionOrder is stable within one entity', () => {
  const ordered = canonicalTransitionOrder([
    row({ node_id: 'MMR-1' }, 'third'),
    row({ node_id: 'MMR-1' }, 'first'),
    row({ node_id: 'MMR-1' }, 'second'),
  ]);
  // The per-entity order is the stored fact (ADR 0015) — never re-sorted, not
  // even by timestamp.
  expect(ordered.map((r) => r.at)).toEqual(['third', 'first', 'second']);
});

test('canonicalTransitionOrder gives an unparseable node id a rank instead of NaN', () => {
  // A hand-written or foreign document can carry an id outside the grammar. A
  // rank of `Number('rogue')` would compare false against everything and leave
  // the whole sort's result undefined, so such an id sorts last, by its id.
  const ordered = canonicalTransitionOrder([
    row({ node_id: 'MMR-rogue' }, 'a'),
    row({ node_id: 'MMR-2' }, 'b'),
    row({ project_id: 'MMR' }, 'c'),
    row({ node_id: 'MMR-alpha' }, 'd'),
  ]);
  expect(entities(ordered)).toEqual(['MMR', 'MMR-2', 'MMR-alpha', 'MMR-rogue']);
});

test('canonicalSetOrder is code-unit order, free of locale and collation', () => {
  // `localeCompare` ranks 'Draft' beside 'draft' and a database collation ranks
  // it under the server's rules; code-unit order puts every capital first.
  expect(canonicalSetOrder(['spec', 'Draft', 'api'])).toEqual(['Draft', 'api', 'spec']);
  expect(canonicalSetOrder(['a-b', 'ab'])).toEqual(['a-b', 'ab']);
});

test('canonicalSetOrder copies rather than sorting in place', () => {
  const tags = ['b', 'a'];
  expect(canonicalSetOrder(tags)).toEqual(['a', 'b']);
  expect(tags).toEqual(['b', 'a']);
});

test('canonicalJson sorts object keys at every depth and leaves arrays alone', () => {
  const text = canonicalJson({
    alpha: { nested: { a: [3, 1, 2], z: null } },
    zeta: [{ a: 1, b: 2 }, 'second', 'first'],
  });
  expect(text).toBe(
    [
      '{',
      '  "alpha": {',
      '    "nested": {',
      '      "a": [',
      '        3,',
      '        1,',
      '        2',
      '      ],',
      '      "z": null',
      '    }',
      '  },',
      '  "zeta": [',
      '    {',
      '      "a": 1,',
      '      "b": 2',
      '    },',
      '    "second",',
      '    "first"',
      '  ]',
      '}',
    ].join('\n'),
  );
});

test('canonicalJson makes two objects equal as values equal as bytes', () => {
  // The fault this fixes: Norn builds a record by spreading a seam record and
  // Postgres by writing a literal, so two equal documents serialized plainly
  // differ on nearly every line.
  // Built key by key, because the repo's own lint sorts an authored literal.
  const grown: Record<string, unknown> = {};
  grown.title = 'Transfer spec';
  grown.key = 'MMR';
  grown.seq = 1;
  const literal = { key: 'MMR', seq: 1, title: 'Transfer spec' };
  expect(JSON.stringify(grown)).not.toBe(JSON.stringify(literal));
  expect(canonicalJson(grown)).toBe(canonicalJson(literal));
});
