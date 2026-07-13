import { expect, test } from 'bun:test';

import type { NornClient } from '../../norn/client';
import { renderAnnotationRecord, renderHistoryRecord, renderNodeBody } from '../history-codec';
import { sliceSection } from '../testing';
import { createNornBodySectionStore, readAllNodeDocs, readSectionFailures } from './norn';

/** A fake client whose `getSections` serves one document's named sections, sliced
 * from the given `.body` the way norn does (heading line included; an absent
 * heading warn-and-omitted). `undefined` models a missing document (no record). */
function clientWithBody(body: string | undefined): NornClient {
  return {
    getSections: (targets: string[], headings: string[]) => {
      expect(targets).toEqual(['MMR-9']);
      if (body === undefined) {
        return Promise.resolve([]);
      }
      const sections: Record<string, string> = {};
      for (const heading of headings) {
        const section = sliceSection(body, heading);
        if (section !== '') {
          sections[heading] = section;
        }
      }
      return Promise.resolve([{ path: 'MMR/MMR-9.md', sections }]);
    },
  } as unknown as NornClient;
}

const HISTORY = {
  at: '2026-07-04T10:00:00.000Z',
  from: 'todo',
  kind: 'lifecycle',
  reason: 'shipped',
  to: 'done',
} as const;
const ANNOTATION = { content: 'a load-bearing note', createdAt: '2026-07-04T10:01:00.000Z' };

/** A realistic node body: the seeded shape with one record under each anchor. */
function nodeBody(): string {
  const base = renderNodeBody('a task');
  return base
    .replace('## History\n', `## History\n${renderHistoryRecord(HISTORY)}`)
    .replace('## Annotations\n', `## Annotations\n${renderAnnotationRecord(ANNOTATION)}`);
}

test('readHistory reads + parses the ## History section natively', async () => {
  const store = createNornBodySectionStore(clientWithBody(nodeBody()));
  expect(await store.readHistory('MMR-9', 'MMR-9')).toEqual([HISTORY]);
});

test('readAnnotations reads + parses the ## Annotations section natively', async () => {
  const store = createNornBodySectionStore(clientWithBody(nodeBody()));
  expect(await store.readAnnotations('MMR-9', 'MMR-9')).toEqual([ANNOTATION]);
});

test('a freshly-seeded node (empty sections) reads back as no records', async () => {
  const store = createNornBodySectionStore(clientWithBody(renderNodeBody('a task')));
  expect(await store.readHistory('MMR-9', 'MMR-9')).toEqual([]);
  expect(await store.readAnnotations('MMR-9', 'MMR-9')).toEqual([]);
});

test('a missing document (no records returned) reads back empty, not a throw', async () => {
  const store = createNornBodySectionStore(clientWithBody(undefined));
  expect(await store.readHistory('MMR-9', 'MMR-9')).toEqual([]);
  expect(await store.readAnnotations('MMR-9', 'MMR-9')).toEqual([]);
});

test('an ambiguous (duplicate) heading reads back empty, not the first section (MMR-239)', async () => {
  // A hand-edited node with two `## History` headings is ambiguous, so norn
  // warn-and-omits the section; with no requested heading resolving, the doc
  // lands in `section_failures` with no record — the read degrades to empty
  // (ADR 0017: no arbitrary first-of-two pick), not a throw. Diagnostic: MMR-239.
  const ambiguous = {
    getSections: (targets: string[]) => {
      expect(targets).toEqual(['MMR-9']);
      return Promise.resolve([]); // doc reported in section_failures, absent from records
    },
  } as unknown as NornClient;
  const store = createNornBodySectionStore(ambiguous);
  expect(await store.readHistory('MMR-9', 'MMR-9')).toEqual([]);
  expect(await store.readAnnotations('MMR-9', 'MMR-9')).toEqual([]);
});

test('readSections reads all requested facets in one getSections round-trip (MMR-164 F6)', async () => {
  // A detail `get` wanting description + annotations + history must cost ONE
  // `vault.get { section }` call requesting all three headings — not three.
  let calls = 0;
  let requested: string[] = [];
  const body = nodeBody();
  const client = {
    getSections: (targets: string[], headings: string[]) => {
      calls += 1;
      requested = headings;
      expect(targets).toEqual(['MMR-9']);
      const sections: Record<string, string> = {};
      for (const heading of headings) {
        const section = sliceSection(body, heading);
        if (section !== '') {
          sections[heading] = section;
        }
      }
      return Promise.resolve([{ path: 'MMR/MMR-9.md', sections }]);
    },
  } as unknown as NornClient;
  const store = createNornBodySectionStore(client);
  const sections = await store.readSections('MMR-9', 'MMR-9', {
    annotations: true,
    description: true,
    history: true,
  });
  expect(calls).toBe(1);
  expect(requested).toEqual(['Task Description', 'Annotations', 'History']);
  expect(sections.description).toBe('a task');
  expect(sections.annotations).toEqual([ANNOTATION]);
  expect(sections.history).toEqual([HISTORY]);
});

test('readSections populates only the requested facets (MMR-164)', async () => {
  const store = createNornBodySectionStore(clientWithBody(nodeBody()));
  const sections = await store.readSections('MMR-9', 'MMR-9', { history: true });
  expect(sections.history).toEqual([HISTORY]);
  expect(sections.annotations).toBeUndefined();
  expect(sections.description).toBeUndefined();
});

test('annotations sort by created-at, not document order', async () => {
  // Two notes appended out of chronological order (a backfill / clock-skew shape)
  // must read back in created-at order.
  const later = { content: 'later note', createdAt: '2026-07-04T12:00:00.000Z' };
  const earlier = { content: 'earlier note', createdAt: '2026-07-04T09:00:00.000Z' };
  const body = `## Annotations\n${renderAnnotationRecord(later)}${renderAnnotationRecord(earlier)}`;
  const store = createNornBodySectionStore(clientWithBody(body));
  expect(await store.readAnnotations('MMR-9', 'MMR-9')).toEqual([earlier, later]);
});

// ── readAllNodeDocs (MMR-166): the `mimir doctor` raw-body reader ─────────

/** A fake client whose `find` yields the doc paths and `get` their `.body`. */
function fakeVault(docs: { path: string; body: string }[]): NornClient {
  return {
    find: () => Promise.resolve(docs.map((d) => ({ path: d.path }))),
    get: (targets: string[], col?: string) => {
      expect(col).toBe('.body');
      return Promise.resolve(docs.filter((d) => targets.includes(d.path)));
    },
  } as unknown as NornClient;
}

test('readAllNodeDocs returns every doc as { stem, body }, stem stripped of dir + .md', async () => {
  const docs = await readAllNodeDocs(
    fakeVault([
      { body: nodeBody(), path: 'MMR/MMR-9.md' },
      { body: renderNodeBody('a project'), path: 'MMR/MMR.md' },
    ]),
  );
  expect(docs).toEqual([
    { body: nodeBody(), stem: 'MMR-9' },
    { body: renderNodeBody('a project'), stem: 'MMR' },
  ]);
});

test('readAllNodeDocs short-circuits an empty vault without calling get', async () => {
  const client = {
    find: () => Promise.resolve([]),
    get: () => {
      throw new Error('get must not be called for an empty vault');
    },
  } as unknown as NornClient;
  expect(await readAllNodeDocs(client)).toEqual([]);
});

test('readAllNodeDocs pushes a scope into the find as project:KEY, omits it when unscoped (MMR-170)', async () => {
  const seen: { eq?: string[]; in?: string[] }[] = [];
  const client = {
    find: (args: { eq?: string[]; in?: string[] }) => {
      seen.push(args);
      return Promise.resolve([]);
    },
    get: () => Promise.resolve([]),
  } as unknown as NornClient;

  await readAllNodeDocs(client, 'MMR');
  expect(seen[0]?.eq).toEqual(['project:MMR']);
  expect(seen[0]?.in).toEqual(['type:project,task,phase,initiative,seed']);

  await readAllNodeDocs(client);
  expect(seen[1]).not.toHaveProperty('eq');
});

test('readSectionFailures enumerates seeds — History over all, Annotations over nodes + seeds (MMR-244)', async () => {
  // A seed doc carries `## History` + `## Annotations` (like a node), so a corrupt
  // one must be enumerated: it belongs in the find `in` filter AND in the
  // Annotations-bearing set (unlike a project, which has no Annotations).
  const findArgs: { in?: string[] }[] = [];
  const sectionCalls: { paths: string[]; heading: string }[] = [];
  const client = {
    find: (args: { in?: string[] }) => {
      findArgs.push(args);
      return Promise.resolve([
        { path: 'MMR/MMR.md' }, // project — ## History only
        { path: 'MMR/MMR-1.md' }, // node — ## History + ## Annotations
        { path: 'MMR/seeds/MMR-s1.md' }, // seed — ## History + ## Annotations
      ]);
    },
    sectionFailures: (paths: string[], sections: string[]) => {
      sectionCalls.push({ heading: sections[0] ?? '', paths });
      return Promise.resolve([]);
    },
  } as unknown as NornClient;

  await readSectionFailures(client);

  expect(findArgs[0]?.in).toEqual(['type:project,task,phase,initiative,seed']);
  const history = sectionCalls.find((c) => c.heading === 'History');
  const annotations = sectionCalls.find((c) => c.heading === 'Annotations');
  // History rides every work-state doc; Annotations only the nodes + seeds — the
  // seed appears in BOTH, the project only in History.
  expect(history?.paths).toEqual(['MMR/MMR.md', 'MMR/MMR-1.md', 'MMR/seeds/MMR-s1.md']);
  expect(annotations?.paths).toEqual(['MMR/MMR-1.md', 'MMR/seeds/MMR-s1.md']);
});
