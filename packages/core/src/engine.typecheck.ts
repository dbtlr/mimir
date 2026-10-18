import type { EngineInput } from '@mimir/contract';

import type { ArtifactQueryOptions, ListOptions, NextOptions } from './intent';
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
  Assert<SameKeys<keyof EngineInput<'search'>, keyof SearchOptions>>,
  // @ts-expect-error A renamed input key no longer matches the core option it feeds.
  Assert<SameKeys<Scoped<'artifacts'> | 'tags', keyof ArtifactQueryOptions>>,
];
