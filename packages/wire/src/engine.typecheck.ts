import type { Engine, engineNodeFromViewSchema, engineSchemas, NodeView } from '@mimir/contract';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import type { z } from 'zod';

import type { EngineProcedures, EngineRouter } from './server';

// Normalize aliases/intersections while retaining Date and optional property presence.
type Shape<T> = T extends Date
  ? Date
  : T extends (infer Item)[]
    ? Shape<Item>[]
    : T extends object
      ? { [K in keyof T]: Shape<T[K]> }
      : T;
// Generic identity distinguishes optional-key drift from mutual assignability.
/* oxlint-disable typescript/no-unnecessary-type-parameters */
type Identical<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/* oxlint-enable typescript/no-unnecessary-type-parameters */
type Equal<A, B> = Identical<Shape<A>, Shape<B>>;
type Assert<T extends true> = T;
type Inputs = { [K in keyof Engine]: Parameters<Engine[K]>[0] };
type Outputs = { [K in keyof Engine]: Awaited<ReturnType<Engine[K]>> };
type InputWithoutFacets = Omit<Inputs, 'getNode'> & {
  getNode: Omit<Inputs['getNode'], 'facets'>;
};
type InputWithExtra = Omit<Inputs, 'getNode'> & {
  getNode: Inputs['getNode'] & { accidental?: string };
};
type OutputWithoutHistory = { [K in keyof Engine]: Omit<Outputs[K], 'history'> };
type OutputWithExtra = { [K in keyof Engine]: Outputs[K] & { accidental?: string } };

/** These assertions run in the normal typecheck, including the negative controls. */
export type EngineTypeChecks = [
  Assert<Equal<keyof Engine, keyof typeof engineSchemas>>,
  Assert<Equal<Inputs, inferRouterInputs<EngineRouter>>>,
  Assert<Equal<Outputs, inferRouterOutputs<EngineRouter>>>,
  Assert<Equal<NodeView, z.input<typeof engineNodeFromViewSchema>>>,
  // @ts-expect-error A missing procedure cannot implement the Engine.
  Assert<Equal<keyof Omit<EngineProcedures, 'done'>, keyof Engine>>,
  // @ts-expect-error A changed input cannot satisfy the Engine contract.
  Assert<Equal<Inputs, Omit<Inputs, 'done'> & { done: { id: number } }>>,
  // @ts-expect-error Removing an optional input field still changes the contract.
  Assert<Equal<Inputs, InputWithoutFacets>>,
  // @ts-expect-error Adding an optional input field still changes the contract.
  Assert<Equal<Inputs, InputWithExtra>>,
  // @ts-expect-error A changed output cannot satisfy the Engine contract.
  Assert<Equal<Outputs, Omit<Outputs, 'done'> & { done: string }>>,
  // @ts-expect-error Removing an optional output field still changes the contract.
  Assert<Equal<Outputs, OutputWithoutHistory>>,
  // @ts-expect-error Adding an optional output field still changes the contract.
  Assert<Equal<Outputs, OutputWithExtra>>,
];
