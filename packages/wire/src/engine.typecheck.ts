import type {
  ArtifactDetail,
  ArtifactSummary,
  Engine,
  engineSchemas,
  intentViews,
  NodeView,
  OverviewReport,
  OverviewScratchpad,
  Scratchpad,
  SearchHit,
  SeedView,
  SetResult,
  StatusView,
  TreeView,
} from '@mimir/contract';
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
// Whole-surface identity over this many methods exceeds what the checker compares
// reliably, so surfaces compare key sets and then each method's shape.
type EveryKey<A, B> =
  Equal<keyof A, keyof B> extends true
    ? false extends { [K in keyof A & keyof B]: Equal<A[K], B[K]> }[keyof A & keyof B]
      ? false
      : true
    : false;
type Intent = { [K in keyof typeof intentViews]: z.input<(typeof intentViews)[K]> };
/** Each decoded view accepts exactly the string-valued core projection it replaces. */
type CoreProjections = {
  artifactDetail: ArtifactDetail;
  artifactSet: SetResult<ArtifactSummary>;
  node: NodeView;
  nodeSet: SetResult<NodeView>;
  nodes: NodeView[];
  overview: OverviewReport;
  scratchpad: Scratchpad;
  scratchpadRows: OverviewScratchpad[];
  searchSet: SetResult<SearchHit>;
  seed: SeedView;
  seeds: SeedView[];
  status: StatusView;
  tree: TreeView;
};
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
  Assert<EveryKey<Inputs, inferRouterInputs<EngineRouter>>>,
  Assert<EveryKey<Outputs, inferRouterOutputs<EngineRouter>>>,
  Assert<EveryKey<CoreProjections, Intent>>,
  // @ts-expect-error A view that drops a core field no longer matches its projection.
  Assert<EveryKey<CoreProjections, Omit<Intent, 'seed'> & { seed: Omit<SeedView, 'lede'> }>>,
  // @ts-expect-error A missing procedure cannot implement the Engine.
  Assert<Equal<keyof Omit<EngineProcedures, 'done'>, keyof Engine>>,
  // @ts-expect-error A changed input cannot satisfy the Engine contract.
  Assert<EveryKey<Inputs, Omit<Inputs, 'done'> & { done: { id: number } }>>,
  // @ts-expect-error Removing an optional input field still changes the contract.
  Assert<EveryKey<Inputs, InputWithoutFacets>>,
  // @ts-expect-error Adding an optional input field still changes the contract.
  Assert<EveryKey<Inputs, InputWithExtra>>,
  // @ts-expect-error A changed output cannot satisfy the Engine contract.
  Assert<EveryKey<Outputs, Omit<Outputs, 'done'> & { done: string }>>,
  // @ts-expect-error Removing an optional output field still changes the contract.
  Assert<EveryKey<Outputs, OutputWithoutHistory>>,
  // @ts-expect-error Adding an optional output field still changes the contract.
  Assert<EveryKey<Outputs, OutputWithExtra>>,
];
