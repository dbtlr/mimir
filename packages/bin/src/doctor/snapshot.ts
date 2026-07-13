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
import { validate } from '../core/validate';
import type { NornClient, NornDocument } from '../norn/client';
import type { ValidateFinding } from '../norn/decode';
import { decodeValidateFindings, stemOf } from '../norn/decode';
import type { DoctorContext } from './checks';

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
    .map(({ body, stem }) => ({ body, stem }));
  return {
    dropped: validate(snapshot.graph).dropped,
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
