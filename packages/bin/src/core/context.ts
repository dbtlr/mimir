import type { Kysely, Transaction } from 'kysely';

import type {
  Annotation as AnnotationRow,
  ArtifactLink as ArtifactLinkRow,
  Artifact as ArtifactRow,
  DB,
  Dependency as DependencyRow,
  Node as NodeRow,
  Project as ProjectRow,
  Tag as TagRow,
  TransitionRow as TransitionLogRow,
} from '../db/schema';
import type {
  Annotation,
  Artifact,
  ArtifactLink,
  Dependency,
  Node,
  Project,
  Tag,
  TransitionRow,
} from './model';

/**
 * Executor aliases. Public verbs take a `Db` and open their own transaction;
 * the internal steps thread a `Tx`. `Transaction<DB>` is a `Kysely<DB>`, so a
 * helper typed `Tx` also accepts the root handle in read-only paths.
 */
export type Db = Kysely<DB>;
export type Tx = Transaction<DB>;

/**
 * The SQLite row shapes must stay assignable to the backend-neutral domain
 * model (`core/model.ts`, ADR 0016 Phase 0) — that is what lets the core
 * consume Kysely results with no mapping layer. A schema change that drifts
 * from the model fails these assertions at compile time. They live here (not
 * in `db/schema.ts`) because the layering runs contract ← db ← core: the db
 * layer may not import core.
 */
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type ModelChecks = [
  Assert<Equals<ProjectRow, Project>>,
  Assert<Equals<NodeRow, Node>>,
  Assert<Equals<DependencyRow, Dependency>>,
  Assert<Equals<AnnotationRow, Annotation>>,
  Assert<Equals<ArtifactRow, Artifact>>,
  Assert<Equals<ArtifactLinkRow, ArtifactLink>>,
  Assert<Equals<TagRow, Tag>>,
  Assert<Equals<TransitionLogRow, TransitionRow>>,
];
