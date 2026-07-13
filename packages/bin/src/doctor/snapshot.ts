/**
 * One reusable whole-vault diagnostic snapshot (MMR-241). Doctor used to run
 * three near-identical `vault.find` scans to obtain bodies, graph inputs, and
 * section-failure paths. This seam enumerates work-state documents once, opts in
 * the body + full-content hash that deterministic repair planning needs, and
 * derives every document-based diagnostic input from that one post-refresh view.
 */
import { readSectionFailuresFromDocuments } from '../core/body-sections/norn';
import type { VaultGraph } from '../core/store-norn';
import { vaultGraphFromDocs } from '../core/store-norn';
import type { Drop } from '../core/validate';
import { validate } from '../core/validate';
import type { NornClient, NornDocument } from '../norn/client';
import type { ValidateFinding } from '../norn/decode';
import { decodeValidateFindings, stemOf } from '../norn/decode';
import type { DoctorContext } from './checks';
import { workStateStem } from './checks';

const WORK_STATE_TYPES = 'type:project,task,phase,initiative,seed';

/** One physical document in the snapshot. Path is its locator; stem is identity. */
export type DoctorSnapshotDocument = {
  path: string;
  stem: string;
  frontmatter?: Record<string, unknown>;
  body: string;
  /** Full-content BLAKE3 from Norn, suitable for a later plan CAS precondition. */
  documentHash: string | null;
};

/** All inputs needed to diagnose one coherent whole-vault enumeration. */
export type DoctorSnapshot = {
  documents: readonly DoctorSnapshotDocument[];
  graph: VaultGraph;
  sectionFailures: readonly { stem: string; section: string }[];
  validateFindings: readonly ValidateFinding[];
};

/** Keep the project document and every canonically-owned child in `scope`. */
export function doctorStemInScope(stem: string, scope: string | undefined): boolean {
  return scope === undefined || stem === scope || stem.startsWith(`${scope}-`);
}

/** Every known physical owner of a logical stem. Typed enumeration is exact
 * provenance even at a relocated path; validate-only paths count only when they
 * match a canonical work-state layout. */
export function doctorPhysicalPathsByStem(
  snapshot: DoctorSnapshot,
): ReadonlyMap<string, ReadonlySet<string>> {
  const pathsByStem = new Map<string, Set<string>>();
  const add = (stem: string, path: string): void => {
    const paths = pathsByStem.get(stem) ?? new Set<string>();
    paths.add(path);
    pathsByStem.set(stem, paths);
  };
  for (const doc of snapshot.documents) {
    add(doc.stem, doc.path);
  }
  for (const finding of snapshot.validateFindings) {
    const stem = workStateStem(finding.path);
    if (stem !== null) {
      add(stem, finding.path);
    }
  }
  return pathsByStem;
}

function diagnosticDrops(snapshot: DoctorSnapshot): Drop[] {
  const dropped = [...validate(snapshot.graph).dropped];
  const existing = new Set(
    dropped.flatMap((drop) =>
      drop.rule === 'duplicate-stem' ? [`${drop.stem}\0${drop.path}`] : [],
    ),
  );
  for (const [stem, ownerPaths] of doctorPhysicalPathsByStem(snapshot)) {
    if (ownerPaths.size <= 1) {
      continue;
    }
    const paths = [...ownerPaths].toSorted();
    for (const path of paths) {
      const key = `${stem}\0${path}`;
      if (!existing.has(key)) {
        dropped.push({ kind: 'identity', path, paths, rule: 'duplicate-stem', stem });
        existing.add(key);
      }
    }
  }
  return dropped;
}

function snapshotDocument(doc: NornDocument): DoctorSnapshotDocument {
  return {
    body: typeof doc.body === 'string' ? doc.body : '',
    documentHash: typeof doc.document_hash === 'string' ? doc.document_hash : null,
    ...(doc.frontmatter === undefined ? {} : { frontmatter: doc.frontmatter }),
    path: doc.path,
    stem: stemOf(doc.path),
  };
}

/**
 * Read one complete diagnostic snapshot. `vault.validate` remains its own Norn
 * operation because it can see malformed/untyped documents excluded by the type
 * enumeration, but it is captured in this same reusable value rather than being
 * independently orchestrated by each doctor transport.
 */
export async function readDoctorSnapshot(client: NornClient): Promise<DoctorSnapshot> {
  const found = await client.find({
    col: ['.frontmatter', '.body', '.document_hash'],
    in: [WORK_STATE_TYPES],
    no_limit: true,
  });
  const sectionFailures = await readSectionFailuresFromDocuments(client, found);
  const validateFindings = decodeValidateFindings(await client.validate());
  return {
    documents: found.map(snapshotDocument),
    graph: vaultGraphFromDocs(found, { withSeeds: true }),
    sectionFailures,
    validateFindings,
  };
}

/**
 * Project a whole-vault snapshot into the shared check context. Per-document
 * inputs honor scope by canonical stem after enumeration (MMR-240); relational
 * drops remain whole-vault because one broken edge can invalidate the global
 * graph. CLI and HTTP both use this function, so their scope semantics cannot
 * drift while repair later consumes the unfiltered snapshot.
 */
export function doctorContextFromSnapshot(
  snapshot: DoctorSnapshot,
  scope: string | undefined,
): DoctorContext {
  const docs = snapshot.documents
    .filter((doc) => doctorStemInScope(doc.stem, scope))
    .map(({ body, path, stem }) => ({ body, path, stem }));
  return {
    dropped: diagnosticDrops(snapshot),
    projectRefs: snapshot.graph.declarations ?? [],
    readNodeDocs: () => Promise.resolve(docs),
    sectionFailures: snapshot.sectionFailures.filter((failure) =>
      doctorStemInScope(failure.stem, scope),
    ),
    validateFindings: snapshot.validateFindings.filter((finding) =>
      doctorStemInScope(stemOf(finding.path), scope),
    ),
  };
}
