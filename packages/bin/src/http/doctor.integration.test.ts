import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Server } from 'bun';

import { createProject } from '../core';
import type { Store } from '../core';
import type { DoctorFacet } from '../doctor/facet';
import { computeDoctorFacet } from '../doctor/serve';
import type { DoctorFacetDeps } from '../doctor/serve';
import { readDoctorSnapshot } from '../doctor/snapshot';
import { bunExec } from '../exec';
import { NornClient } from '../norn/client';
import { pathAndRaw } from '../norn/decode';
import { createNornWriteStore } from '../norn/writer';
import { converge } from '../vault/converge';
import { createServer } from './server';

/** The /api/doctor record-health facet (MMR-185) end-to-end over a real Norn store
 * with hand-seeded corruption. Needs `norn`. */
const NORN = Bun.which('norn') !== null;

let root: string;
let vault: string;
let client: NornClient;
let store: Store;
let server: Server<undefined>;
let base: string;

/** Wire the facet provider exactly as `main.ts` does — the read handles over the
 * live client. */
function doctorProvider(): (scope: string | undefined) => Promise<DoctorFacet> {
  const deps: DoctorFacetDeps = {
    readRaw: async (paths) => {
      if (paths.length === 0) {
        return [];
      }
      const records = await client.get(paths, '.raw');
      return records.flatMap((r) => {
        const pr = pathAndRaw(r);
        return pr === null ? [] : [pr];
      });
    },
    readSnapshot: () => readDoctorSnapshot(client),
  };
  return (scope) => computeDoctorFacet(deps, scope);
}

beforeEach(async () => {
  root = mkdtemp();
  vault = join(root, 'vault');
  await converge(vault, { allowCreate: true, exec: bunExec });
  client = new NornClient({ vaultPath: vault });
  store = createNornWriteStore(client, vault);
  await createProject(store, { key: 'MMR', name: 'Mimir' });
});

afterEach(async () => {
  await server.stop(true);
  await client.close();
  rmSync(root, { force: true, recursive: true });
});

function mkdtemp(): string {
  const dir = join(
    tmpdir(),
    `mimir-doctor-${String(Date.now())}-${String(Math.random()).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write a doc straight into the vault directory — the test's corruption seam. */
function seed(relPath: string, contents: string): void {
  const full = join(vault, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, contents);
}

describe.skipIf(!NORN)('/api/doctor', () => {
  test('a clean vault yields no groups and no dropped records', async () => {
    server = createServer(store, {
      doctor: doctorProvider(),
      hunt: false,
      port: 0,
      version: 'test',
    });
    base = `http://127.0.0.1:${String(server.port)}`;
    const facet = (await (await fetch(`${base}/api/doctor`)).json()) as {
      dropped_total: number;
      groups: unknown[];
      scanned_at: string;
    };
    expect(facet.dropped_total).toBe(0);
    expect(facet.groups).toEqual([]);
    expect(typeof facet.scanned_at).toBe('string');
  });

  test('reports groups + causes for the three seeded corruptions', async () => {
    // 1. Illegal status word — a task with a foreign lifecycle (valid frontmatter,
    //    so the reader sees it; only the enum is bad).
    seed(
      'MMR/MMR-1.md',
      [
        '---',
        'type: task',
        "title: 'Board polish: hover states'",
        'project: MMR',
        'priority: p2',
        'size: small',
        'lifecycle: dnoe',
        '---',
        '',
        '## Task Description',
        '',
        'Body.',
        '',
        '## History',
        '',
      ].join('\n'),
    );
    // 2. Foreign type — a work-state path whose `type` is not a vault type, so the
    //    reader never sees it (norn's schema pass surfaces it).
    seed(
      'MMR/MMR-2.md',
      ['---', 'type: widget', 'title: mystery', 'project: MMR', '---', '', 'Body.', ''].join('\n'),
    );
    // 3. Malformed frontmatter — YAML that will not parse.
    seed(
      'MMR/MMR-3.md',
      ['---', 'type: task', 'title: [unterminated', 'bad: : :', '---', '', 'x'].join('\n'),
    );

    server = createServer(store, {
      doctor: doctorProvider(),
      hunt: false,
      port: 0,
      version: 'test',
    });
    base = `http://127.0.0.1:${String(server.port)}`;

    const facet = (await (await fetch(`${base}/api/doctor`)).json()) as {
      dropped_total: number;
      groups: {
        project: string;
        path: string;
        dropped: number;
        readable: number;
        records: {
          id: string;
          cause: string;
          field: string | null;
          value: string | null;
          suggestion: string | null;
          title: string | null;
          location: { line: number; byte: number } | null;
          snippet: { lines: { n: number; text: string; offending?: unknown }[] } | null;
        }[];
      }[];
    };

    expect(facet.dropped_total).toBeGreaterThanOrEqual(3);
    const mmr = facet.groups.find((g) => g.project === 'MMR');
    expect(mmr).toBeDefined();
    expect(mmr?.path).toBe('MMR');
    const causes = new Set(mmr?.records.map((r) => r.cause));
    expect(causes.has('illegal status word')).toBe(true);
    expect(causes.has('foreign type')).toBe(true);
    expect(causes.has('malformed frontmatter')).toBe(true);

    // The illegal-status record is fully enriched from `.raw`.
    const lifecycle = mmr?.records.find((r) => r.cause === 'illegal status word');
    expect(lifecycle).toMatchObject({
      field: 'lifecycle',
      id: 'MMR-1',
      suggestion: 'done',
      title: 'Board polish: hover states',
      value: 'dnoe',
    });
    expect(lifecycle?.location?.line).toBeGreaterThan(0);
    const offendingLine = lifecycle?.snippet?.lines.find((l) => l.offending !== undefined);
    expect(offendingLine?.text).toContain('dnoe');

    // The parse-failed doc resolves its `.raw` too (fetched by path), so a snippet
    // is present even though the reader can't parse the frontmatter.
    const malformed = mmr?.records.find((r) => r.cause === 'malformed frontmatter');
    expect(malformed?.snippet).not.toBeNull();
  });

  test('?project scopes the facet to one project group', async () => {
    seed(
      'MMR/MMR-1.md',
      [
        '---',
        'type: task',
        'title: t',
        'project: MMR',
        'lifecycle: dnoe',
        '---',
        '',
        '## History',
        '',
      ].join('\n'),
    );
    server = createServer(store, {
      doctor: doctorProvider(),
      hunt: false,
      port: 0,
      version: 'test',
    });
    base = `http://127.0.0.1:${String(server.port)}`;
    const facet = (await (await fetch(`${base}/api/doctor?project=MMR`)).json()) as {
      dropped_total: number;
      groups: { project: string }[];
    };
    expect(facet.groups.every((g) => g.project === 'MMR')).toBe(true);
    expect(facet.dropped_total).toBeGreaterThanOrEqual(1);
  });
});
