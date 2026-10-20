import { z } from 'zod';

import { consoleSchemas, engineSchemas } from '../src/engine';

type ProcedureSchemas = Record<
  string,
  { input: z.ZodType; kind: 'query' | 'mutation'; output: z.ZodType }
>;

// Pinned Zod features whose input/output behavior has an explicit representation here.
const schemaOptions = new Map<string, readonly string[]>([
  ['array', ['element']],
  ['boolean', []],
  ['date', []],
  ['enum', ['entries']],
  ['literal', ['values']],
  ['never', []],
  ['nullable', ['innerType']],
  ['number', []],
  ['object', ['shape', 'catchall']],
  ['optional', ['innerType']],
  ['record', ['keyType', 'valueType', 'partial']],
  ['string', []],
  ['union', ['options', 'inclusive', 'discriminator']],
]);
const schemaTraits = new Set([
  '$ZodArray',
  '$ZodBoolean',
  '$ZodCheck',
  '$ZodCheckGreaterThan',
  '$ZodCheckMinLength',
  '$ZodCheckNumberFormat',
  '$ZodCheckRegex',
  '$ZodCheckStringFormat',
  '$ZodDate',
  '$ZodDiscriminatedUnion',
  '$ZodEnum',
  '$ZodLiteral',
  '$ZodNever',
  '$ZodNullable',
  '$ZodNumber',
  '$ZodNumberFormat',
  '$ZodObject',
  '$ZodObjectJIT',
  '$ZodOptional',
  '$ZodRecord',
  '$ZodString',
  '$ZodType',
  '$ZodUnion',
]);
const checkOptions = new Map<string, readonly string[]>([
  ['greater_than', ['inclusive', 'value']],
  ['less_than', ['inclusive', 'value']],
  ['multiple_of', ['value']],
  ['number_format', ['format']],
  ['min_length', ['minimum']],
  ['max_length', ['maximum']],
  ['length_equals', ['length']],
  ['string_format', ['format', 'pattern']],
]);
const checksByOwner = new Map<string, readonly string[]>([
  ['string', ['min_length', 'max_length', 'length_equals', 'string_format']],
  ['number', ['greater_than', 'less_than', 'multiple_of', 'number_format']],
  ['array', ['min_length', 'max_length', 'length_equals']],
]);
// JSON Schema drops a bound whose value it cannot write, while parsing still enforces it.
const representableValues = new Map<string, (value: unknown) => boolean>([
  ['value', Number.isFinite],
  ['minimum', Number.isSafeInteger],
  ['maximum', Number.isSafeInteger],
  ['length', Number.isSafeInteger],
]);
const lengthWhen = z.array(z.unknown()).min(1)._zod.def.checks?.[0]?._zod.def.when;

/** New Zod behavior must be represented deliberately before a contract can use it. */
function assertSupportedSchema(schema: z.core.$ZodType) {
  const definition = schema._zod.def;
  const options = schemaOptions.get(definition.type);
  if (!options) {
    throw new Error(`unsupported schema type: ${definition.type}; add a snapshot representation`);
  }
  for (const trait of schema._zod.traits) {
    if (trait.startsWith('$Zod') && !schemaTraits.has(trait)) {
      throw new Error(`unsupported schema trait: ${trait}; add a snapshot representation`);
    }
  }
  for (const key of Object.keys(definition)) {
    if (
      !['type', 'checks', 'error', 'abort', 'check', 'format'].includes(key) &&
      !options.includes(key)
    ) {
      throw new Error(
        `unsupported schema option: ${definition.type}.${key}; add a snapshot representation`,
      );
    }
  }
}

/** Reject behavior that the JSON Schema conversion would otherwise discard. */
function assertSnapshotBehavior(schema: z.core.$ZodType) {
  const definition = schema._zod.def;
  const checks = [definition, ...(definition.checks?.map((check) => check._zod.def) ?? [])];
  for (const check of checks) {
    if ('pattern' in check && check.pattern instanceof RegExp && check.pattern.flags) {
      throw new Error('regex flags require an explicit snapshot representation');
    }
    if (
      'format' in check &&
      check.format === 'url' &&
      (('hostname' in check && check.hostname !== undefined) ||
        ('protocol' in check && check.protocol !== undefined) ||
        ('normalize' in check && check.normalize))
    ) {
      throw new Error('URL constraints require an explicit snapshot representation');
    }
  }
  for (const check of checks) {
    if (!('check' in check) || typeof check.check !== 'string') {
      continue;
    }
    if (check.check === 'custom') {
      throw new Error('custom refinements require an explicit snapshot representation');
    }
    if (check.check === 'overwrite') {
      throw new Error('schema behavior requires an explicit snapshot representation');
    }
    const options = checkOptions.get(check.check);
    if (!options) {
      throw new Error(`unsupported schema check: ${check.check}; add a snapshot representation`);
    }
    if (!checksByOwner.get(definition.type)?.includes(check.check)) {
      throw new Error(
        `unsupported check on ${definition.type}: ${check.check}; add a snapshot representation`,
      );
    }
    if (
      'format' in check &&
      ((check.check === 'string_format' && check.format !== 'regex') ||
        (check.check === 'number_format' && check.format !== 'safeint'))
    ) {
      throw new Error(
        `unsupported schema format: ${String(check.format)}; add a snapshot representation`,
      );
    }
    if (
      'when' in check &&
      check.when !== undefined &&
      !(
        ['min_length', 'max_length', 'length_equals'].includes(check.check) &&
        check.when === lengthWhen
      )
    ) {
      throw new Error('custom check conditions require an explicit snapshot representation');
    }
    for (const key of Object.keys(check)) {
      if (
        !['type', 'checks', 'check', 'abort', 'error', 'when'].includes(key) &&
        !options.includes(key)
      ) {
        throw new Error(
          `unsupported check option: ${check.check}.${key}; add a snapshot representation`,
        );
      }
    }
    for (const option of options) {
      const representable = representableValues.get(option);
      if (representable && !representable(Reflect.get(check, option))) {
        throw new Error(`unrepresentable check value: ${check.check}.${option}`);
      }
    }
  }
  if (
    definition.type === 'pipe' ||
    definition.type === 'transform' ||
    definition.type === 'catch' ||
    ('coerce' in definition && definition.coerce)
  ) {
    throw new Error('schema behavior requires an explicit snapshot representation');
  }
  assertSupportedSchema(schema);
}

function procedureSchemas(procedures: ProcedureSchemas, direction: 'input' | 'output') {
  return z.strictObject(
    Object.fromEntries(
      Object.entries(procedures).map(([name, schema]) => [
        name,
        z.strictObject({
          kind: z.literal(schema.kind),
          schema: schema[direction],
        }),
      ]),
    ),
  );
}

/** Dates cross the wire through Superjson; unsupported schema types must never disappear. */
function schemaDocument(direction: 'input' | 'output') {
  return z.toJSONSchema(
    z.strictObject({
      console: procedureSchemas(consoleSchemas, direction),
      engine: procedureSchemas(engineSchemas, direction),
    }),
    {
      io: direction,
      metadata: z.registry(),
      override: ({ zodSchema, jsonSchema }) => {
        assertSnapshotBehavior(zodSchema);
        const definition = zodSchema._zod.def;
        if ('discriminator' in definition) {
          jsonSchema['x-mimir-discriminator'] = definition.discriminator;
        }
      },
      reused: 'ref',
      unrepresentable: ({ zodSchema, message }) => {
        if (zodSchema._zod.def.type === 'date') {
          if (zodSchema._zod.def.checks?.length || zodSchema._zod.def.coerce) {
            throw new Error('Date constraints require an explicit snapshot representation');
          }
          return { format: 'date-time', type: 'string', 'x-mimir-type': 'Date' };
        }
        throw new Error(message);
      },
    },
  );
}

/** Separate documents preserve input strictness and the decoded output contract. */
export function engineSchemaSnapshot() {
  return { input: schemaDocument('input'), output: schemaDocument('output') };
}

if (import.meta.main) {
  await Bun.write(
    new URL('../engine-schemas.json', import.meta.url),
    `${JSON.stringify(engineSchemaSnapshot(), null, 2)}\n`,
  );
}
