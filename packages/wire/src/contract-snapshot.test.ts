import { expect, test } from 'bun:test';

import { consoleSchemas, engineSchemas } from '@mimir/contract';
import { z } from 'zod';

import { engineSchemaSnapshot } from '../../contract/scripts/engine-schema-snapshot';

test('Engine schemas match the reviewed JSON Schema snapshot; regenerate with bun run contract:snapshot', async () => {
  const snapshot = await Bun.file(
    new URL('../../contract/engine-schemas.json', import.meta.url),
  ).json();
  expect(engineSchemaSnapshot()).toEqual(snapshot);
});

test('a breaking Date constraint cannot disappear from compatibility review', () => {
  const original = engineSchemas.overview.input;
  const changed = original.extend({
    asOf: z.date().min(new Date('2100-01-01T00:00:00Z')).optional(),
  });
  const input = { asOf: new Date('2026-01-01T00:00:00Z'), project: 'MMR' };
  expect(original.safeParse(input).success).toBe(true);
  expect(changed.safeParse(input).success).toBe(false);
  Reflect.set(engineSchemas.overview, 'input', changed);
  try {
    expect(() => {
      engineSchemaSnapshot();
    }).toThrow('Date constraints require an explicit snapshot representation');
  } finally {
    Reflect.set(engineSchemas.overview, 'input', original);
  }
});

test('a custom refinement cannot silently bypass compatibility review', () => {
  const original = engineSchemas.overview.input;
  const changed = original.extend({
    project: original.shape.project.refine((value) => value !== 'MMR'),
  });
  expect(original.safeParse({ project: 'MMR' }).success).toBe(true);
  expect(changed.safeParse({ project: 'MMR' }).success).toBe(false);
  Reflect.set(engineSchemas.overview, 'input', changed);
  try {
    expect(() => {
      engineSchemaSnapshot();
    }).toThrow('custom refinements require an explicit snapshot representation');
  } finally {
    Reflect.set(engineSchemas.overview, 'input', original);
  }
});

test('input strictness changes require a regenerated snapshot', () => {
  const original = consoleSchemas.openTasks.input;
  const before = engineSchemaSnapshot();
  const changed = z.object(original.shape);
  expect(original.safeParse({ extra: true, q: '' }).success).toBe(false);
  expect(changed.safeParse({ extra: true, q: '' }).success).toBe(true);
  Reflect.set(consoleSchemas.openTasks, 'input', changed);
  try {
    expect(engineSchemaSnapshot()).not.toEqual(before);
  } finally {
    Reflect.set(consoleSchemas.openTasks, 'input', original);
  }
});

test.each([
  { name: 'string rewrite', q: z.string().toLowerCase() },
  { name: 'preprocess', q: z.preprocess(() => 'lower', z.string()) },
])('$name cannot silently bypass compatibility review', ({ q }) => {
  const original = consoleSchemas.openTasks.input;
  const changed = z.strictObject({ q });
  expect(original.parse({ q: 'UPPER' })).toEqual({ q: 'UPPER' });
  expect(changed.parse({ q: 'UPPER' })).not.toEqual({ q: 'UPPER' });
  Reflect.set(consoleSchemas.openTasks, 'input', changed);
  try {
    expect(() => {
      engineSchemaSnapshot();
    }).toThrow('schema behavior requires an explicit snapshot representation');
  } finally {
    Reflect.set(consoleSchemas.openTasks, 'input', original);
  }
});

test('regex flags cannot silently bypass compatibility review', () => {
  const original = consoleSchemas.openTasks.input;
  const changed = z.strictObject({ q: z.string().regex(/abc/i) });
  expect(z.string().regex(/abc/).safeParse('ABC').success).toBe(false);
  expect(changed.safeParse({ q: 'ABC' }).success).toBe(true);
  Reflect.set(consoleSchemas.openTasks, 'input', changed);
  try {
    expect(() => {
      engineSchemaSnapshot();
    }).toThrow('regex flags require an explicit snapshot representation');
  } finally {
    Reflect.set(consoleSchemas.openTasks, 'input', original);
  }
});

test.each([
  { input: 'http://example.test', name: 'protocol', q: z.url({ protocol: /^https$/ }) },
  { input: 'https://elsewhere.test', name: 'hostname', q: z.url({ hostname: /^example.test$/ }) },
])('URL $name constraints cannot silently bypass compatibility review', ({ q, input }) => {
  const original = consoleSchemas.openTasks.input;
  const changed = z.strictObject({ q });
  expect(z.url().safeParse(input).success).toBe(true);
  expect(changed.safeParse({ q: input }).success).toBe(false);
  Reflect.set(consoleSchemas.openTasks, 'input', changed);
  try {
    expect(() => {
      engineSchemaSnapshot();
    }).toThrow('URL constraints require an explicit snapshot representation');
  } finally {
    Reflect.set(consoleSchemas.openTasks, 'input', original);
  }
});

test('built-in property checks cannot silently bypass compatibility review', () => {
  const original = consoleSchemas.openTasks.input;
  const changed = original.extend({
    q: original.shape.q.check(z.property('length', z.number().min(4))),
  });
  expect(original.safeParse({ q: 'abc' }).success).toBe(true);
  expect(changed.safeParse({ q: 'abc' }).success).toBe(false);
  Reflect.set(consoleSchemas.openTasks, 'input', changed);
  try {
    expect(() => {
      engineSchemaSnapshot();
    }).toThrow('unsupported schema check: property');
  } finally {
    Reflect.set(consoleSchemas.openTasks, 'input', original);
  }
});

test('exact optional inputs cannot silently change explicit-undefined acceptance', () => {
  const original = engineSchemas.overview.input;
  const changed = original.extend({ asOf: z.exactOptional(z.date()) });
  const input = { asOf: undefined, project: 'MMR' };
  expect(original.safeParse(input).success).toBe(true);
  expect(changed.safeParse(input).success).toBe(false);
  Reflect.set(engineSchemas.overview, 'input', changed);
  try {
    expect(() => {
      engineSchemaSnapshot();
    }).toThrow('unsupported schema trait: $ZodExactOptional');
  } finally {
    Reflect.set(engineSchemas.overview, 'input', original);
  }
});

// One case per guard the generator applies to a check. Each uses zod a
// contributor can write without a cast; the real contract trips none of them,
// so the snapshot test alone cannot tell a guard from its absence.

test('unreviewed string formats cannot silently discard format-specific options', () => {
  const original = consoleSchemas.openTasks.input;
  Reflect.set(consoleSchemas.openTasks, 'input', z.strictObject({ q: z.jwt({ alg: 'HS256' }) }));
  try {
    expect(() => {
      engineSchemaSnapshot();
    }).toThrow('unsupported schema format: jwt');
  } finally {
    Reflect.set(consoleSchemas.openTasks, 'input', original);
  }
});

test('a check the owning processor cannot represent is refused', () => {
  const before = z.enum(['alpha', 'b']);
  const after = before.check(z.maxLength(3));
  expect(before.safeParse('alpha').success).toBe(true);
  expect(after.safeParse('alpha').success).toBe(false);
  const original = consoleSchemas.openTasks.input;
  Reflect.set(consoleSchemas.openTasks, 'input', z.strictObject({ q: after }));
  try {
    expect(() => {
      engineSchemaSnapshot();
    }).toThrow('unsupported check on');
  } finally {
    Reflect.set(consoleSchemas.openTasks, 'input', original);
  }
});

test('constraint metadata cannot override generated validation constraints', () => {
  const before = z.string();
  const after = z.string().min(4).meta({ minLength: undefined });
  expect(before.safeParse('abc').success).toBe(true);
  expect(after.safeParse('abc').success).toBe(false);
  const original = consoleSchemas.openTasks.input;
  try {
    Reflect.set(consoleSchemas.openTasks, 'input', original.extend({ q: before }));
    const previous = engineSchemaSnapshot();
    Reflect.set(consoleSchemas.openTasks, 'input', original.extend({ q: after }));
    expect(engineSchemaSnapshot()).not.toEqual(previous);
  } finally {
    Reflect.set(consoleSchemas.openTasks, 'input', original);
  }
});

test('a number bound JSON Schema cannot represent is refused', () => {
  const after = z.number().int().gt(Number.NaN);
  expect(z.number().int().safeParse(-5).success).toBe(true);
  expect(after.safeParse(-5).success).toBe(false);
  const original = engineSchemas.search.input;
  Reflect.set(engineSchemas.search, 'input', original.extend({ limit: after.optional() }));
  try {
    expect(() => {
      engineSchemaSnapshot();
    }).toThrow('unrepresentable check value');
  } finally {
    Reflect.set(engineSchemas.search, 'input', original);
  }
});
