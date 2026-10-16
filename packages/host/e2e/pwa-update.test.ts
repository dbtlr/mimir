import { expect } from '@playwright/test';

import { precacheUrls } from './pwa-fixture';
import { test } from './pwa-worker';

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 15_000 });

test('two builds defer updates per tab and preserve offline operation', async ({
  context,
  pwaFixture: fixture,
}) => {
  const cachedProjectTitle = 'Offline-ready operator project';
  const pageA = await context.newPage();
  await pageA.goto(fixture.origin);
  await pageA.evaluate(() => navigator.serviceWorker.ready);
  await expect(pageA.getByRole('status').filter({ hasText: 'Update' })).toHaveCount(0);
  await expect(pageA.getByText(cachedProjectTitle, { exact: true })).toBeVisible();

  await pageA.getByRole('button', { exact: true, name: 'All projects' }).click();
  await pageA.getByRole('button', { name: 'New project' }).click();
  const title = pageA.getByRole('dialog').getByLabel('Title');
  await title.fill('Unsaved operator work');

  fixture.useBuildB();
  const pageB = await context.newPage();
  await pageB.goto(fixture.origin);
  await pageB.evaluate(() => navigator.serviceWorker.ready);
  await expect(pageB.getByRole('status').filter({ hasText: 'Update ready' })).toBeVisible();
  await pageA.bringToFront();
  await expect(
    pageA.getByRole('status', { includeHidden: true }).filter({ hasText: 'Update ready' }),
  ).toBeVisible();
  await expect(title).toHaveValue('Unsaved operator work');

  await pageB.bringToFront();
  await pageB.getByRole('button', { name: 'Refresh now' }).click();
  await expect(pageB.getByTestId('console-version')).toHaveAttribute('title', /console build-b/);
  await test.step('the deferred tab preserves input and adopts build B explicitly', async () => {
    await expect(title).toHaveValue('Unsaved operator work');
    await expect(
      pageA.getByRole('status', { includeHidden: true }).filter({ hasText: 'Update installed' }),
    ).toBeVisible();
    // The modal correctly blocks shell actions; the operator finishes or
    // closes that work before taking the explicit refresh transition.
    await pageA.getByRole('dialog').press('Escape');
    await pageA.getByRole('button', { name: 'Refresh now' }).click();
    await expect(pageA.getByTestId('console-version')).toHaveAttribute('title', /console build-b/);
  });

  await test.step('cached reads open offline and heal after reconnect', async () => {
    await context.setOffline(true);
    await pageA.goto(`${fixture.origin}/p/PWA/tasks`);
    await expect(pageA.getByRole('link', { exact: true, name: 'Mimir' })).toBeVisible();
    await pageA.goto(fixture.origin);
    await pageA.reload();
    await expect(pageA.getByRole('link', { exact: true, name: 'Mimir' })).toBeVisible();
    await expect(pageA.getByRole('status').filter({ hasText: 'Offline' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(pageA.getByText(cachedProjectTitle, { exact: true })).toBeVisible();
    await pageA.getByRole('button', { exact: true, name: 'All projects' }).click();
    await expect(pageA.getByRole('button', { name: 'New project' })).toBeDisabled();

    await context.setOffline(false);
    await expect(pageA.getByRole('status').filter({ hasText: 'Offline' })).toHaveCount(0, {
      timeout: 20_000,
    });
    await expect(pageA.getByRole('button', { name: 'New project' })).toBeEnabled();
    await pageA.getByRole('combobox', { name: 'Find a project' }).press('Escape');
  });

  await test.step('server routes never navigate to the cached shell', async () => {
    const probe = await context.newPage();
    await probe.goto(fixture.origin);
    await probe.evaluate(() => navigator.serviceWorker.ready);
    await context.setOffline(true);
    try {
      for (const prefix of ['api', 'trpc', '_serverFn', 'health']) {
        for (const path of [`/${prefix}`, `/${prefix}?probe=1`, `/${prefix}/probe`]) {
          const outcome = await probe.goto(`${fixture.origin}${path}`).then(
            (response) => response?.status(),
            () => null,
          );
          expect(outcome, `offline server navigation ${path}`).not.toBe(200);
        }
      }
    } finally {
      await context.setOffline(false);
      await probe.close();
    }
  });

  await test.step('health mismatch uses the shared refresh path', async () => {
    fixture.setHealthVersion('daemon-mismatch');
    await pageA.reload();
    const mismatch = pageA.getByRole('button', { name: 'refresh console' });
    await expect(mismatch).toBeVisible();
    fixture.setHealthVersion('build-b');
    await mismatch.click();
    await expect(pageA.getByRole('button', { name: 'refresh console' })).toHaveCount(0);
  });

  const urls = await precacheUrls(fixture.buildB);
  expect(new Set(urls).size).toBe(urls.length);
  expect(urls).toEqual(expect.arrayContaining(['_shell.html', 'manifest.webmanifest']));
});
