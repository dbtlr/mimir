/**
 * Vault data migrations — the doc-content backfills a schema bump needs, the
 * counterpart to {@link ./converge}'s structural upgrade (marker + rules). A
 * structural bump alone leaves existing documents in the old shape; these
 * rewrite them forward through Norn (ADR 0018: vault access is Norn-only), so an
 * upgraded vault is not merely *declared* current but actually is.
 *
 * Injected into `converge` as `migrateData` and run BEFORE the marker bump, so a
 * crash mid-backfill leaves the marker at the old schema and the next converge
 * retries. Every backfill is idempotent (it targets only the docs still missing
 * the change), so a resumed run completes the remainder.
 */
import { parseIdentity, wikilink } from '../core/ids';
import { NornClient } from '../core/store-norn/client';
import { stemOf } from '../core/store-norn/decode';

/** The vault schema that introduced the `project` frontmatter field (MMR-170). */
const PROJECT_FIELD_SCHEMA = 3;

const WORK_STATE_TYPES = 'type:project,task,phase,initiative';

/**
 * Backfill the `project` frontmatter field (MMR-170) onto work-state documents
 * that predate it. The project key comes from the document's **stem** — the
 * `KEY`/`KEY-seq` identity, parsed with {@link parseIdentity} — never from its
 * directory: the `KEY/…` path layout is deliberately irrelevant to identity, so
 * the stem is the sole source. The field is written as a wikilink to the project
 * document, exactly what `nodeFrontmatter`/`projectFrontmatter` emit. Idempotent
 * — it targets only documents actually missing the field (`--missing project`) —
 * so a re-run after a partial write completes the rest. Returns the changed
 * paths.
 */
export async function backfillProjectField(client: NornClient): Promise<string[]> {
  const docs = await client.find({ in: [WORK_STATE_TYPES], missing: ['project'], no_limit: true });
  const changed: string[] = [];
  for (const doc of docs) {
    const stem = stemOf(doc.path);
    const key = parseIdentity(stem)?.key;
    if (key === undefined) {
      continue; // an unparseable stem — leave it for doctor to surface
    }
    // Address the document by its STEM, never its path — the stem resolves
    // cleanly and the `KEY/…` layout is deliberately irrelevant. `confirm: true`
    // applies the write (an unconfirmed `set` is a preview).
    await client.set({ confirm: true, set: { project: wikilink(key) }, target: stem });
    changed.push(doc.path);
  }
  return changed;
}

/**
 * `converge`'s `migrateData` hook: run every data migration an upgrade from
 * `fromSchema` needs, over a transient client at `path`. Returns the changed
 * document paths for converge to stage. A no-op (no client spawned) when the
 * vault is already at or past every migration's target schema.
 */
export async function backfillVaultData(path: string, fromSchema: number): Promise<string[]> {
  if (fromSchema >= PROJECT_FIELD_SCHEMA) {
    return [];
  }
  const client = new NornClient({ vaultPath: path });
  try {
    return await backfillProjectField(client);
  } finally {
    await client.close();
  }
}
