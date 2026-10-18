import type { ConsoleInput, Engine, EngineInput } from '@mimir/contract';

import type {
  CreateNodeInitiativeInput,
  CreateNodePhaseInput,
  CreateNodeProjectInput,
  CreateNodeTaskInput,
} from './create';
import type {
  ArtifactQueryOptions,
  ListOptions,
  NextOptions,
  ReviewOptions,
  WorkOptions,
} from './intent';
import type { AttachArtifactInput, UpdateFields, UpdateProjectFields } from './mutations';
import type { ScratchpadService } from './scratchpads';
import type { SearchOptions } from './search/intent';
import type {
  promoteSeed,
  FileSeedInput,
  ListSeedsOptions,
  PromoteSeedInput,
  TriageOptions,
  UpdateSeedFields,
} from './seeds';

type Assert<T extends true> = T;
type SameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** The option keys a board read hands core, after `project` becomes core's `scope`. */
type Scoped<K extends 'artifacts' | 'list' | 'next'> =
  | Exclude<keyof EngineInput<K>, 'project'>
  | 'scope';

type ScratchOptions<M extends keyof ScratchpadService> = keyof Parameters<ScratchpadService[M]>[1];
type WithoutId<K extends keyof ScratchpadWrites> = Exclude<keyof EngineInput<K>, 'id'>;
type ScratchpadWrites = {
  scratchAgendaAdd: 'agendaAdd';
  scratchAgendaComplete: 'agendaComplete';
  scratchAgendaSupersede: 'agendaSupersede';
  scratchCheckpoint: 'checkpoint';
  scratchDiscard: 'discard';
  scratchFreeze: 'freeze';
  scratchUpdate: 'updateMetadata';
};

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
  Assert<SameKeys<keyof EngineInput<'seedCreate'>, keyof FileSeedInput>>,
  Assert<SameKeys<Exclude<keyof EngineInput<'seedPromote'>, 'id'>, keyof PromoteSeedInput>>,
  Assert<SameKeys<Exclude<keyof EngineInput<'seedUpdate'>, 'id'>, keyof UpdateSeedFields>>,
  Assert<SameKeys<keyof EngineInput<'triage'>, keyof TriageOptions>>,
  Assert<
    SameKeys<keyof EngineInput<'scratchCreate'>, keyof Parameters<ScratchpadService['create']>[0]>
  >,
  Assert<SameKeys<WithoutId<'scratchAgendaAdd'>, ScratchOptions<'agendaAdd'>>>,
  Assert<SameKeys<WithoutId<'scratchAgendaComplete'>, ScratchOptions<'agendaComplete'>>>,
  Assert<SameKeys<WithoutId<'scratchAgendaSupersede'>, ScratchOptions<'agendaSupersede'>>>,
  Assert<SameKeys<WithoutId<'scratchCheckpoint'>, ScratchOptions<'checkpoint'>>>,
  Assert<SameKeys<WithoutId<'scratchDiscard'>, ScratchOptions<'discard'>>>,
  Assert<SameKeys<WithoutId<'scratchFreeze'>, ScratchOptions<'freeze'>>>,
  Assert<SameKeys<WithoutId<'scratchUpdate'>, ScratchOptions<'updateMetadata'>>>,
  // The promotion view is parsed from core's result, so a field core adds or renames must
  // reach the Engine output rather than be stripped.
  Assert<
    SameKeys<
      keyof Awaited<ReturnType<typeof promoteSeed>>,
      keyof Awaited<ReturnType<Engine['seedPromote']>>
    >
  >,
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

/** The console inputs hand core the same page options; ids and keys are the extra field. */
export type ConsoleOptionChecks = [
  Assert<SameKeys<keyof ConsoleInput<'review'>, keyof ReviewOptions>>,
  Assert<SameKeys<Exclude<keyof ConsoleInput<'projectWork'>, 'project'>, keyof WorkOptions>>,
  Assert<SameKeys<Exclude<keyof ConsoleInput<'nodeWork'>, 'id'>, keyof WorkOptions>>,
  // @ts-expect-error A renamed console input key no longer matches the page option it feeds.
  Assert<SameKeys<keyof ConsoleInput<'review'> | 'zone', keyof ReviewOptions>>,
];
