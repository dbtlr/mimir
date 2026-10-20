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

test('custom check conditions cannot silently disable a represented bound', () => {
  const original = consoleSchemas.openTasks.input;
  const bounded = original.extend({ q: original.shape.q.min(4) });
  const condition = new z.core.$ZodCheckMinLength({
    check: 'min_length',
    minimum: 4,
    when: () => false,
  });
  const changed = original.extend({ q: original.shape.q.check(condition) });
  expect(bounded.safeParse({ q: 'abc' }).success).toBe(false);
  expect(changed.safeParse({ q: 'abc' }).success).toBe(true);
  Reflect.set(consoleSchemas.openTasks, 'input', changed);
  try {
    expect(() => {
      engineSchemaSnapshot();
    }).toThrow('custom check conditions require an explicit snapshot representation');
  } finally {
    Reflect.set(consoleSchemas.openTasks, 'input', original);
  }
});

/** Exercise checks that JavaScript callers can attach despite TypeScript's narrower API. */
function checkedAtRuntime(schema: z.ZodType, check: unknown): z.ZodType {
  const result: unknown = Reflect.apply(schema.check.bind(schema), schema, [check]);
  if (!(result instanceof z.ZodType)) {
    throw new Error('expected a Zod schema');
  }
  return result;
}

test.each([
  {
    after: z.enum(['alpha', 'b']).check(z.maxLength(3)),
    before: z.enum(['alpha', 'b']),
    input: 'alpha',
    name: 'enum maximum length',
  },
  {
    after: z.enum(['alpha', 'b']).check(z.minLength(6)),
    before: z.enum(['alpha', 'b']),
    input: 'alpha',
    name: 'enum minimum length',
  },
  {
    after: z.literal('alpha').check(z.maxLength(3)),
    before: z.literal('alpha'),
    input: 'alpha',
    name: 'literal maximum length',
  },
  {
    after: checkedAtRuntime(z.number(), z.regex(/^1/)),
    before: z.number(),
    input: 5,
    name: 'number regex',
  },
  {
    after: checkedAtRuntime(z.string(), z.gt(3)),
    before: z.string(),
    input: 'abc',
    name: 'string numeric bound',
  },
  {
    after: checkedAtRuntime(z.boolean(), z.gt(0)),
    before: z.boolean(),
    input: false,
    name: 'boolean numeric bound',
  },
])('$name is refused when the owning processor cannot represent it', ({ after, before, input }) => {
  expect(before.safeParse(input).success).toBe(true);
  expect(after.safeParse(input).success).toBe(false);
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

const inheritedMetadata = z.string().min(1).meta({ minLength: 1 });
test.each([
  {
    after: z.string().min(4).meta({ minLength: undefined }),
    before: z.string(),
    name: 'direct undefined constraint metadata',
  },
  {
    after: inheritedMetadata.min(4),
    before: inheritedMetadata,
    name: 'inherited constraint metadata',
  },
])('$name cannot override generated validation constraints', ({ after, before }) => {
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

test.each([
  { after: z.number().int().check(z.gt(0n)), name: 'bigint number bound' },
  {
    after: z
      .number()
      .int()
      .check(z.gt(new Date(0))),
    name: 'Date number bound',
  },
  { after: z.number().int().gt(Number.NaN), name: 'NaN number bound' },
  {
    after: checkedAtRuntime(
      z.number().int(),
      Reflect.construct(z.core.$ZodCheckGreaterThan, [{ check: 'greater_than', inclusive: false }]),
    ),
    name: 'missing number bound',
  },
])('$name is refused because JSON Schema cannot represent it', ({ after }) => {
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

test.each([
  { check: Reflect.apply(z.minLength, undefined, ['4']), name: 'non-number length bound' },
  {
    check: Reflect.construct(z.core.$ZodCheckMinLength, [{ check: 'min_length' }]),
    name: 'missing length bound',
  },
])('$name is refused because JSON Schema cannot represent it', ({ check }) => {
  const after = checkedAtRuntime(z.string(), check);
  expect(z.string().safeParse('abc').success).toBe(true);
  expect(after.safeParse('abc').success).toBe(false);
  const original = consoleSchemas.openTasks.input;
  Reflect.set(consoleSchemas.openTasks, 'input', original.extend({ q: after }));
  try {
    expect(() => {
      engineSchemaSnapshot();
    }).toThrow('unrepresentable check value');
  } finally {
    Reflect.set(consoleSchemas.openTasks, 'input', original);
  }
});
