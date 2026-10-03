import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { Server } from 'bun';

import { createProject } from '../core';
import type { Store } from '../core';
import type { DoctorBackend } from '../doctor/contract';
import { createTestStore } from '../testing/store';
import { createServer } from './server';

/** The /api/doctor record-health facet (MMR-185) end-to-end over a real store,
 * wired exactly as `main.ts` does — the backend's own facet. */
let store: Store;
let doctor: DoctorBackend;
let closeStore: () => Promise<void>;
let server: Server<undefined>;
let base: string;

beforeEach(async () => {
  ({ close: closeStore, doctor, store } = await createTestStore());
  await createProject(store, { key: 'MMR', name: 'Mimir' });
});

afterEach(async () => {
  await server.stop(true);
  await closeStore();
});

describe('/api/doctor', () => {
  test('a clean store yields no groups and no findings', async () => {
    server = createServer(store, {
      doctor: doctor.facet,
      hunt: false,
      port: 0,
      version: 'test',
    });
    base = `http://127.0.0.1:${String(server.port)}`;
    const facet = (await (await fetch(`${base}/api/doctor`)).json()) as {
      finding_total: number;
      groups: unknown[];
      scanned_at: string;
      scope: { key: string; matched_records: number } | null;
    };
    expect(facet.finding_total).toBe(0);
    expect(facet.groups).toEqual([]);
    expect(typeof facet.scanned_at).toBe('string');
    expect(facet.scope).toBeNull();
  });

  test('?project distinguishes a stale scope from a clean matching scope', async () => {
    server = createServer(store, {
      doctor: doctor.facet,
      hunt: false,
      port: 0,
      version: 'test',
    });
    base = `http://127.0.0.1:${String(server.port)}`;
    const facet = (await (await fetch(`${base}/api/doctor?project=OTH`)).json()) as {
      finding_total: number;
      groups: unknown[];
      scope: { key: string; matched_records: number } | null;
    };
    expect(facet.finding_total).toBe(0);
    expect(facet.groups).toEqual([]);
    expect(facet.scope).toEqual({ key: 'OTH', matched_records: 0 });

    const matching = (await (await fetch(`${base}/api/doctor?project=MMR`)).json()) as {
      finding_total: number;
      scope: { key: string; matched_records: number } | null;
    };
    expect(matching.finding_total).toBe(0);
    expect(matching.scope?.key).toBe('MMR');
    expect(matching.scope?.matched_records).toBeGreaterThan(0);
  });
});
