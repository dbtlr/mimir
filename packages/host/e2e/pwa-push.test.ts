import { expect } from '@playwright/test';

import { test } from './pwa-worker';

test.use({ actionTimeout: 15_000 });

/**
 * MMR-710: the installed console shows a Web Push and a tap on it opens the
 * record it names. The push is delivered through the DevTools Protocol, as the
 * browser's push service would; the tap is a `notificationclick` the worker
 * receives for the notification the push showed.
 */
test('a delivered push shows a notification and a tap opens its record', async ({
  context,
  pwaFixture: fixture,
}) => {
  await context.grantPermissions(['notifications'], { origin: fixture.origin });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const registration = new Promise<string>((resolve) => {
    cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
      const found = registrations.find((entry) => entry.scopeURL === `${fixture.origin}/`);
      if (found !== undefined) {
        resolve(found.registrationId);
      }
    });
  });
  await cdp.send('ServiceWorker.enable');
  await page.goto(fixture.origin);
  await page.evaluate(() => navigator.serviceWorker.ready);
  // A first load is not controlled; the installed app is, and only a
  // controlled window accepts the worker's navigate().
  await page.reload();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);

  const target = `${fixture.origin}/p/PWA/tasks`;
  await cdp.send('ServiceWorker.deliverPushMessage', {
    data: JSON.stringify({
      app_badge: 1,
      notification: {
        body: 'A decision is waiting.',
        dir: 'ltr',
        lang: 'en',
        navigate: target,
        tag: 'decision:PWA-1',
        title: 'Decision needed',
      },
      web_push: 8030,
    }),
    origin: fixture.origin,
    registrationId: await registration,
  });

  const worker = context.serviceWorkers().find((entry) => entry.url().startsWith(fixture.origin));
  if (worker === undefined) {
    throw new Error('the console service worker is not running');
  }
  // The worker's own scope has no DOM typings here, so its code goes in as source.
  const shownNotifications = `self.registration.getNotifications().then(
    (shown) => shown.map((entry) => [entry.title, entry.tag]))`;
  await expect
    .poll(() => worker.evaluate(shownNotifications))
    .toEqual([['Decision needed', 'decision:PWA-1']]);

  await worker.evaluate(`self.registration.getNotifications().then(([notification]) =>
    self.dispatchEvent(new NotificationEvent('notificationclick', { notification }))
  )`);
  await page.waitForURL(target);
  await expect.poll(() => worker.evaluate(shownNotifications)).toEqual([]);
});
