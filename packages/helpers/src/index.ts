/**
 * Typed `JSON.parse`. The stdlib returns `any`, which forces an unsafe `as`
 * cast at every call site; this encapsulates that one boundary so callers stay
 * honest.
 *
 *   const x = parseJson<Foo>(text);        // typed cast — trusted input
 *   const x = parseJson(text, FooSchema);  // validated — any Standard Schema
 *
 * The validated form accepts any [Standard Schema](https://standardschema.dev)
 * (zod 4, valibot, arktype, …) and throws on a mismatch, so untrusted input can
 * be parsed safely without coupling this util to a specific validation library.
 */

/** Minimal Standard Schema v1 surface — inlined to keep this package dependency-free. */
export type StandardSchemaV1<Output = unknown> = {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly output: Output };
  };
};

type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly { readonly message: string }[] };

type InferOutput<S extends StandardSchemaV1> =
  S extends StandardSchemaV1<infer Output> ? Output : never;

/**
 * Type-narrowing membership check — `value` is `T` when it's one of `allowed`.
 * Lets callers validate-then-narrow untrusted strings into an enum type without
 * an unsafe `as` cast: `if (!isMember(v, PRIORITY_VALUES)) reject(); // v: Priority`.
 */
export function isMember<T extends string>(value: string, allowed: readonly T[]): value is T {
  return allowed.some((member) => member === value);
}

// T is the caller-specified return type of the typed-cast form — single-use by design.
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
export function parseJson<T = unknown>(text: string): T;
export function parseJson<S extends StandardSchemaV1>(text: string, schema: S): InferOutput<S>;
export function parseJson(text: string, schema?: StandardSchemaV1): unknown {
  const data: unknown = JSON.parse(text);
  if (schema === undefined) {
    return data;
  }
  const result = schema['~standard'].validate(data);
  if (result instanceof Promise) {
    throw new TypeError('parseJson: schema must validate synchronously');
  }
  if (result.issues !== undefined) {
    throw new Error(`parseJson: ${result.issues.map((i) => i.message).join('; ')}`);
  }
  return result.value;
}
