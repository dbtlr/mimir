import { sql } from "kysely";
import type { ArtifactSummary } from "@mimir/contract";
import type { Db } from "./context";
import { renderArtifactRef } from "./ids";

/** Portfolio artifact search (MMR-52). All filters compose with AND. */
export interface ArtifactQuery {
  project?: string;
  tag?: string;
  since?: string;
  before?: string;
  q?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 100;

/**
 * The cross-project artifact feed — metadata only (the body is never in a list).
 * `q` is a case-insensitive substring over title+content (LIKE; FTS5 is the
 * documented scale-up). Newest-first by `created_at`.
 */
export async function listArtifacts(
  db: Db,
  opts: ArtifactQuery = {},
): Promise<{ total: number; items: ArtifactSummary[] }> {
  let base = db.selectFrom("artifact").innerJoin("project", "project.id", "artifact.project_id");
  if (opts.project !== undefined) {
    base = base.where("project.key", "=", opts.project);
  }
  if (opts.since !== undefined) {
    base = base.where("artifact.created_at", ">=", opts.since);
  }
  if (opts.before !== undefined) {
    base = base.where("artifact.created_at", "<=", opts.before);
  }
  if (opts.q !== undefined) {
    const like = `%${opts.q.toLowerCase()}%`;
    base = base.where(
      sql<boolean>`(lower(artifact.title) LIKE ${like} OR lower(artifact.content) LIKE ${like})`,
    );
  }
  if (opts.tag !== undefined) {
    const tag = opts.tag;
    base = base.where("artifact.id", "in", (qb) =>
      qb
        .selectFrom("tag")
        .select("entity_id")
        .where("entity_type", "=", "artifact")
        .where("tag", "=", tag),
    );
  }

  const { c } = await base
    .select((eb) => eb.fn.countAll<number>().as("c"))
    .executeTakeFirstOrThrow();

  const rows = await base
    .select([
      "artifact.id as id",
      "artifact.seq as seq",
      "project.key as key",
      "artifact.title as title",
      "artifact.created_at as createdAt",
    ])
    .orderBy("artifact.created_at", "desc")
    .orderBy("artifact.id", "desc")
    .limit(opts.limit ?? DEFAULT_LIMIT)
    .execute();

  const items: ArtifactSummary[] = [];
  for (const row of rows) {
    const tagRows = await db
      .selectFrom("tag")
      .select("tag")
      .where("entity_type", "=", "artifact")
      .where("entity_id", "=", row.id)
      .orderBy("created_at", "asc")
      .execute();
    items.push({
      id: renderArtifactRef({ key: row.key, seq: row.seq }),
      title: row.title,
      project: row.key,
      tags: tagRows.map((t) => t.tag),
      createdAt: row.createdAt,
    });
  }
  return { total: Number(c), items };
}
