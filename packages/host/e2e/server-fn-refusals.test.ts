import { expect } from '@playwright/test';

import { test } from './pwa-worker';

test.use({ actionTimeout: 15_000 });

/** A line the host writes for each internal fault, as /trpc does. */
const FAULT_LINE = '✗ host: request did not complete';

/*
 * Server functions against a real built host (MMR-537): an Engine refusal
 * reaches the console with its code, and an internal fault reaches it as the
 * house refusal alone while its cause goes to the host's log once.
 */
test('server functions answer refusals with their code and hide internal faults', async ({
  page,
  pwaFixture: fixture,
}) => {
  await fixture.create({ key: 'FLT', name: 'Fault board', type: 'project' });
  const initiative = await fixture.create({
    parent: 'FLT',
    title: 'Damaged later',
    type: 'initiative',
  });

  // The sidebar reads FLT's tree through its server function; keep that call's URL.
  const treeCall = page.waitForRequest(
    (request) => request.url().includes('/_serverFn/') && request.url().includes('%22FLT%22'),
  );
  await page.goto(`${fixture.origin}/p/FLT`);
  const treeUrl = new URL((await treeCall).url());
  const callTree = (key: string) =>
    page.evaluate(
      async (url) => {
        const response = await fetch(url, {
          headers: { accept: 'application/json', 'x-tsr-serverFn': 'true' },
        });
        return response.text();
      },
      `${treeUrl.pathname}${treeUrl.search.replace('%22FLT%22', `%22${key}%22`)}`,
    );
  // Call from a page that runs no console, so nothing else reaches the host meanwhile.
  await page.goto(`${fixture.origin}/health`);

  await test.step('an Engine refusal crosses with its code', async () => {
    const body = await callTree('NOPE');
    expect(body).toContain('$TSR/t/mimir-error');
    expect(body).toContain('"not_found"');
  });

  await test.step('a cross-site server-function read is refused before it runs', async () => {
    const response = await fetch(`${fixture.origin}${treeUrl.pathname}${treeUrl.search}`, {
      headers: { 'sec-fetch-site': 'cross-site', 'x-tsr-serverFn': 'true' },
    });
    expect(response.status).toBe(403);
  });

  await test.step('an internal fault crosses as the refusal alone, its cause logged once', async () => {
    // A timestamp no read can decode: the tree's projection fails inside the host.
    await fixture.damageStore(
      'UPDATE node SET created_at = ? WHERE id = ?',
      '0-not-a-time',
      initiative.id,
    );
    try {
      const logged = fixture.hostLog().filter((line) => line.includes(FAULT_LINE)).length;
      const body = await callTree('FLT');
      expect(body).toContain('$TSR/t/mimir-fault');
      for (const leak of ['0-not-a-time', 'createdAt', 'stack', 'Zod', '.ts', '.mjs']) {
        expect(body, `the refusal carries no ${leak}`).not.toContain(leak);
      }
      await expect
        .poll(() => fixture.hostLog().filter((line) => line.includes(FAULT_LINE)).length)
        .toBe(logged + 1);
      const line = fixture.hostLog().filter((entry) => entry.includes(FAULT_LINE))[logged];
      expect(line).toContain('"serverFn":"tree"');
    } finally {
      await fixture.damageStore(
        'UPDATE node SET created_at = ? WHERE id = ?',
        '2026-10-18T00:00:00.000Z',
        initiative.id,
      );
    }
  });
});
