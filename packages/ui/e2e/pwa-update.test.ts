import { expect, test } from '@playwright/test';

import { PwaFixture, precacheUrls } from './pwa-fixture';

test.describe.configure({ mode: 'serial' });

test('two builds defer updates per tab and preserve offline operation', async ({ context }) => {
  const fixture = await PwaFixture.create();
  try {
    const pageA = await context.newPage();
    await pageA.goto(fixture.origin);
    await pageA.evaluate(() => navigator.serviceWorker.ready);
    await expect(pageA.getByRole('status').filter({ hasText: 'Update' })).toHaveCount(0);

    await pageA.getByRole('button', { name: 'New project' }).first().click();
    const title = pageA.getByRole('dialog').getByLabel('Title');
    await title.fill('Unsaved operator work');

    fixture.useBuildB();
    const pageB = await context.newPage();
    await pageB.goto(fixture.origin);
    await pageB.evaluate(() => navigator.serviceWorker.ready);
    await expect(pageB.getByRole('status').filter({ hasText: 'Update ready' })).toBeVisible();
    await pageA.bringToFront();
    await expect(pageA.getByRole('status').filter({ hasText: 'Update ready' })).toBeVisible();
    await expect(title).toHaveValue('Unsaved operator work');

    await pageB.bringToFront();
    await pageB.getByRole('button', { name: 'Refresh now' }).click();
    await expect(pageB.locator('footer span')).toHaveAttribute('title', /console build-b/);
    await test.step('the deferred tab preserves input and adopts build B explicitly', async () => {
      await expect(title).toHaveValue('Unsaved operator work');
      await expect(
        pageA.getByRole('status').filter({ hasText: 'Update installed' }),
      ).toBeVisible();
      // The modal correctly blocks shell actions; the operator finishes or
      // closes that work before taking the explicit refresh transition.
      await pageA.getByRole('dialog').press('Escape');
      await pageA.getByRole('button', { name: 'Refresh now' }).click();
      await expect(pageA.locator('footer span')).toHaveAttribute('title', /console build-b/);
    });

    await test.step('cached reads open offline and heal after reconnect', async () => {
      await context.setOffline(true);
      await pageA.reload();
      await expect(pageA.getByRole('button', { name: 'New project' }).first()).toBeVisible();
      await expect(pageA.getByRole('status').filter({ hasText: 'Offline' })).toBeVisible({
        timeout: 20_000,
      });
      await expect(pageA.getByRole('button', { name: 'New project' }).first()).toBeDisabled();

      await context.setOffline(false);
      await expect(pageA.getByRole('status').filter({ hasText: 'Offline' })).toHaveCount(0, {
        timeout: 20_000,
      });
      await expect(pageA.getByRole('button', { name: 'New project' }).first()).toBeEnabled();
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
    expect(urls).toEqual(expect.arrayContaining(['index.html', 'manifest.webmanifest']));
  } finally {
    await fixture.close();
  }
});
