/**
 * One reusable whole-vault diagnostic snapshot (MMR-241). Doctor used to run
 * three near-identical `vault.find` scans to obtain bodies, graph inputs, and
 * section-failure paths. This seam enumerates work-state documents once, opts in
 * the body + full-content hash that deterministic repair planning needs, and
 * derives every document-based diagnostic input from that one post-refresh view.
 */
import { readSectionFailuresFromDocuments } from '../core/body-sections/norn';
import { parseIdentity } from '../core/ids';
import type { VaultGraph, VaultGraphSource } from '../core/store-norn';
import { vaultGraphFromDocs } from '../core/store-norn';
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
  sectionFailures: readonly { path: string; stem: string; section: string }[];
  validateFindings: readonly ValidateFinding[];
};

/** Keep the project document and every canonically-owned child in `scope`. */
export function doctorStemInScope(stem: string, scope: string | undefined): boolean {
  return scope === undefined || stem === scope || stem.startsWith(`${scope}-`);
}

/** Every known physical owner of a logical stem. Typed enumeration is exact
 * provenance even at a relocated path; validate-only paths count only when they
 * match a canonical work-state layout. */
function doctorIdentitySources(snapshot: DoctorSnapshot): VaultGraphSource[] {
  const sources: VaultGraphSource[] = [];
  const seen = new Set<string>();
  const add = (source: VaultGraphSource): void => {
    const key = `${source.stem}\0${source.path}`;
    if (!seen.has(key)) {
      sources.push(source);
      seen.add(key);
    }
  };
  const sourcedPaths = new Set<string>();
  for (const source of snapshot.graph.sources ?? []) {
    add(source);
    sourcedPaths.add(source.path);
  }
  for (const doc of snapshot.documents) {
    if (sourcedPaths.has(doc.path)) {
      continue;
    }
    const type = doc.frontmatter?.type;
    const key = doc.frontmatter?.key;
    if (type === 'project' && typeof key === 'string' && key !== '') {
      add({ kind: 'project', path: doc.path, stem: key });
      sourcedPaths.add(doc.path);
      continue;
    }
    const identity = parseIdentity(doc.stem);
    if (identity?.kind === 'node' || identity?.kind === 'project' || identity?.kind === 'seed') {
      add({ kind: identity.kind, path: doc.path, stem: doc.stem });
      sourcedPaths.add(doc.path);
    }
  }
  for (const finding of snapshot.validateFindings) {
    if (sourcedPaths.has(finding.path)) {
      continue;
    }
    const stem = workStateStem(finding.path);
    const identity = stem === null ? null : parseIdentity(stem);
    if (
      stem !== null &&
      (identity?.kind === 'node' || identity?.kind === 'project' || identity?.kind === 'seed')
    ) {
      add({ kind: identity.kind, path: finding.path, stem });
    }
  }
  return sources;
}

export type DoctorIdentityIndex = {
  pathsByStem: ReadonlyMap<string, ReadonlySet<string>>;
  stemsByPath: ReadonlyMap<string, ReadonlySet<string>>;
};

/** Build both directions of physical/logical ownership once for a snapshot. */
export function doctorIdentityIndex(snapshot: DoctorSnapshot): DoctorIdentityIndex {
  const pathsByStem = new Map<string, Set<string>>();
  const stemsByPath = new Map<string, Set<string>>();
  for (const { path, stem } of doctorIdentitySources(snapshot)) {
    const paths = pathsByStem.get(stem) ?? new Set<string>();
    paths.add(path);
    pathsByStem.set(stem, paths);
    const stems = stemsByPath.get(path) ?? new Set<string>();
    stems.add(stem);
    stemsByPath.set(path, stems);
  }
  return { pathsByStem, stemsByPath };
}

/** The one logical identity claimed by an exact physical path, or null when the
 * path is absent or its typed provenance is itself contradictory. */
export function doctorLogicalStemAtPath(index: DoctorIdentityIndex, path: string): string | null {
  const stems = index.stemsByPath.get(path);
  return stems?.size === 1 ? ([...stems][0] ?? null) : null;
}

export function doctorPhysicalPathsByStem(
  snapshot: DoctorSnapshot,
): ReadonlyMap<string, ReadonlySet<string>> {
  return doctorIdentityIndex(snapshot).pathsByStem;
}

function diagnosticDrops(snapshot: DoctorSnapshot): DoctorContext['dropped'] {
  return validate({ ...snapshot.graph, sources: doctorIdentitySources(snapshot) }).dropped;
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
