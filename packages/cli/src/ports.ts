/**
 * What a command needs from the composition root. Commands import neither
 * `@mimir/core` nor a store: `src/app.ts` supplies the Engine, the project
 * binding, and the pure grammar and wire codecs the CLI shares with the other
 * transports. The Engine is the only path to work state.
 */
import type {
  ArtifactDetail,
  Engine,
  FieldFilter,
  NodeView,
  QueryOp,
  SeedView,
  SetResult,
} from '@mimir/contract';

/** The kind of record an id names, by its grammar alone. */
export type IdKind = 'project' | 'node' | 'artifact' | 'seed';

/** The input grammar core owns. Each parser throws a `MimirError` the command reports as usage. */
export type Grammar = {
  /** The kind an id token names, or `undefined` when it names none. */
  idKind: (token: string) => IdKind | undefined;
  /** One `FIELD:VALUE` token (bare `FIELD` for has/missing) as a filter. */
  filterToken: (op: QueryOp, token: string) => FieldFilter;
  /** Refuse an unreadable date bound before the Engine is asked. */
  assertDates: (filters: readonly FieldFilter[], zone: string) => void;
  /** A caller-supplied IANA zone, validated, or `undefined` when none was given. */
  timeZone: (zone: string | undefined) => string | undefined;
};

/** The public wire objects every transport emits for `json` and `jsonl`. */
export type Wire = {
  node: (node: NodeView) => Record<string, unknown>;
  set: (result: SetResult<NodeView>, unit: string) => Record<string, unknown>;
  artifact: (artifact: ArtifactDetail) => Record<string, unknown>;
  seed: (seed: SeedView) => Record<string, unknown>;
};

export type Ports = {
  /** The Engine, opened on first ask, so help and usage errors never open the store. */
  engine: () => Promise<Engine>;
  /** The clone's bound project (ADR 0036), resolved on first ask; `notify` hears an auto-bind. */
  scope: (notify: (line: string) => void) => Promise<string | undefined>;
  grammar: Grammar;
  wire: Wire;
};
