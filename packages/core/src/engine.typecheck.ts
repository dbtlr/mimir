import type { EngineInput } from '@mimir/contract';

import type {
  CreateNodeInitiativeInput,
  CreateNodePhaseInput,
  CreateNodeProjectInput,
  CreateNodeTaskInput,
} from './create';
import type { ArtifactQueryOptions, ListOptions, NextOptions } from './intent';
import type { AttachArtifactInput, UpdateFields, UpdateProjectFields } from './mutations';
import type { SearchOptions } from './search/intent';
import type { ListSeedsOptions } from './seeds';

type Assert<T extends true> = T;
type SameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** The option keys a board read hands core, after `project` becomes core's `scope`. */
type Scoped<K extends 'artifacts' | 'list' | 'next'> =
  | Exclude<keyof EngineInput<K>, 'project'>
  | 'scope';

/**
 * LocalEngine spreads parsed input into core options, which skips excess-property
 * checks; these keep each Engine input's keys equal to the options it feeds.
 */
export type EngineOptionChecks = [
  Assert<SameKeys<Scoped<'next'>, keyof NextOptions>>,
  Assert<SameKeys<Scoped<'list'>, keyof ListOptions>>,
  Assert<SameKeys<Scoped<'artifacts'>, keyof ArtifactQueryOptions>>,
  Assert<SameKeys<keyof EngineInput<'seeds'>, keyof ListSeedsOptions>>,
  Assert<SameKeys<keyof EngineInput<'search'> | 'projectOnly', keyof SearchOptions>>,
  // @ts-expect-error A renamed input key no longer matches the core option it feeds.
  Assert<SameKeys<Scoped<'artifacts'> | 'tags', keyof ArtifactQueryOptions>>,
];

/** One `create` variant of the Engine input, by type. */
type CreateVariant<T extends string> = Extract<EngineInput<'create'>, { type: T }>;

/**
 * The node writes hand their parsed input to core inputs the same way; each
 * line states how a variant's keys differ from the core input it feeds, so a
 * field added on either side fails here. Core accepts a few pass-through keys
 * the Engine schema refuses by construction (`groomed` outside tasks,
 * `openEnded` on tasks and projects, `parentHints`, which only a CLI sends).
 */
export type EngineNodeWriteChecks = [
  Assert<
    SameKeys<keyof CreateVariant<'project'> | 'groomed' | 'openEnded', keyof CreateNodeProjectInput>
  >,
  Assert<SameKeys<keyof CreateVariant<'initiative'> | 'groomed', keyof CreateNodeInitiativeInput>>,
  Assert<
    SameKeys<keyof CreateVariant<'phase'> | 'groomed' | 'parentHints', keyof CreateNodePhaseInput>
  >,
  Assert<
    SameKeys<keyof CreateVariant<'task'> | 'openEnded' | 'parentHints', keyof CreateNodeTaskInput>
  >,
  Assert<SameKeys<keyof EngineInput<'update'>, keyof UpdateFields | 'id'>>,
  Assert<SameKeys<keyof EngineInput<'updateProject'>, keyof UpdateProjectFields | 'id'>>,
  Assert<
    SameKeys<
      Exclude<keyof EngineInput<'attach'>, 'links' | 'project'> | 'linkNodeIds' | 'projectId',
      keyof AttachArtifactInput
    >
  >,
  // @ts-expect-error A field added to core's update vocabulary must reach the Engine input.
  Assert<SameKeys<keyof EngineInput<'update'>, keyof UpdateFields | 'id' | 'added'>>,
];
