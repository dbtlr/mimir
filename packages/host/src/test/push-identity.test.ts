import { describe, expect, it } from 'vitest';

import { deviceLabel, identify } from '../lib/push-identity';

const UA = {
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
};

const label = (userAgent: string, maxTouchPoints = 0, standalone = false) =>
  deviceLabel(identify({ maxTouchPoints, standalone, userAgent }));

describe('deviceLabel', () => {
  it.each([
    ['iPhone Safari', UA.iphoneSafari, 5, false, 'iPhone · Safari'],
    ['iPhone Home Screen app', UA.iphoneSafari, 5, true, 'iPhone · Home Screen app'],
    ['an iPad reporting a Mac', UA.macSafari, 5, false, 'iPad · Safari'],
    ['an iPad Home Screen app reporting a Mac', UA.macSafari, 5, true, 'iPad · Home Screen app'],
    ['Mac Chrome', UA.macChrome, 0, false, 'Mac · Chrome'],
    ['Windows Edge', UA.windowsEdge, 0, false, 'Windows · Edge'],
    ['Android Chrome', UA.androidChrome, 5, false, 'Android · Chrome'],
    ['Linux Firefox', UA.linuxFirefox, 0, false, 'Linux · Firefox'],
    ['an installed desktop browser', UA.macChrome, 0, true, 'Mac · Chrome app'],
    ['an unknown browser', 'Gopher/1.0', 0, false, 'Browser'],
  ])('labels %s', (_name, userAgent, touch, standalone, expected) => {
    expect(label(userAgent, touch, standalone)).toBe(expected);
  });
});
