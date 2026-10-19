/**
 * What a command needs from the composition root. Commands import neither
 * `@mimir/core` nor a store: `src/app.ts` supplies the Engine, the project
 * binding, and the pure grammar and wire codecs the CLI shares with the other
 * transports. The Engine is the only path to work state, with one exception:
 * `releasedByArchive` reads the store directly until the Engine echoes the
 * tasks an archive freed (MMR-561).
 */
import type {
  ArtifactDetail,
  ArtifactSummary,
  DateOp,
  Engine,
  FieldFilter,
  NodeView,
  OverviewReport,
  OverviewScratchpad,
  QueryOp,
  Scratchpad,
  SearchHit,
  SeedView,
  SetResult,
  TreeView,
  TriageReport,
} from '@mimir/contract';

import type { Machine } from './machine';

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
  /** The date filters of a feed whose only date field is `field`, with every date checked. */
  dateFilters: (
    tokens: Readonly<Record<DateOp, readonly string[]>>,
    field: string,
    zone: string,
  ) => { field: string; op: DateOp; value: string }[];
  /** The most hits one search may ask for. */
  maxSearchLimit: number;
};

/** The public wire objects every transport emits for `json` and `jsonl`. */
export type Wire = {
  node: (node: NodeView) => Record<string, unknown>;
  set: (result: SetResult<NodeView>, unit: string) => Record<string, unknown>;
  artifact: (artifact: ArtifactDetail) => Record<string, unknown>;
  seed: (seed: SeedView) => Record<string, unknown>;
  tree: (tree: TreeView) => Record<string, unknown>;
  overview: (report: OverviewReport) => Record<string, unknown>;
  artifactSummary: (artifact: ArtifactSummary) => Record<string, unknown>;
  searchHit: (hit: SearchHit) => Record<string, unknown>;
  scratchRow: (row: OverviewScratchpad) => Record<string, unknown>;
  scratchpad: (pad: Scratchpad) => Record<string, unknown>;
  /** A promote echo: the seed wire plus a sibling `created` task id (MMR-552). */
  promotion: (seed: SeedView, created?: string) => Record<string, unknown>;
  /** The triage report's wire object. */
  triage: (report: TriageReport) => Record<string, unknown>;
  /** A Scratchpad write's compact receipt; `updated_at` is the next concurrency token. */
  scratchReceipt: (scratchpad: Scratchpad) => Record<string, unknown>;
};

export type Ports = {
  /** The Engine, opened on first ask, so help and usage errors never open the store. */
  engine: () => Promise<Engine>;
  /** The clone's bound project (ADR 0036), resolved on first ask; `notify` hears an auto-bind. */
  scope: (notify: (line: string) => void) => Promise<string | undefined>;
  grammar: Grammar;
  wire: Wire;
  /** Ask a yes/no question on the terminal; only an interactive run asks. */
  confirm: (question: string) => Promise<boolean>;
  /** The machine-local services (MMR-553): the binding, doctor, and the store's own upgrade and transfer. */
  machine: Machine;
  /**
   * The out-of-project tasks an archive of `key` just freed. The Engine does not
   * report them, so the composition root reads them from the store; this is the
   * one read around the Engine, and it goes when the Engine echoes them (MMR-561).
   */
  releasedByArchive: (key: string) => Promise<readonly string[]>;
};
