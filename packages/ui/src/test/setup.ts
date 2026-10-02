/// <reference types="vitest/jsdom" />

// Global test setup (matchers + afterEach cleanup), not a test body.
// oxlint-disable vitest/require-top-level-describe
// The matchers entry ships only named exports, so a namespace import is the
// one way to hand the whole set to expect.extend.
// oxlint-disable-next-line import/no-namespace
import * as jestDomMatchers from '@testing-library/jest-dom/matchers';
import { cleanup } from '@testing-library/react';

// Register jest-dom's matchers by hand instead of importing
// '@testing-library/jest-dom/vitest': that entry's type augmentation predates
// Vitest 5's `Assertion<R, T>` and loses the matcher types. The corrected
// augmentation lives in jest-dom-vitest.d.ts.
// oxlint-disable-next-line vitest/require-hook
expect.extend(jestDomMatchers);

// Every human-facing timestamp renders in the reader's zone (ADR 0029), so the
// suite pins one: a date assertion means the same thing on any machine.
// oxlint-disable-next-line vitest/require-hook
process.env.TZ = 'America/New_York';

// Node 26 defines its own global localStorage, so Vitest does not replace it
// while copying jsdom's globals. Point the browser global at jsdom's in-memory
// storage instead of requiring Node's persistent --localstorage-file.
const jsdomStorage = jsdom.window.localStorage;
// This must run during setup, before test modules import browser code.
// oxlint-disable-next-line vitest/require-hook
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  get: () => jsdomStorage,
});

// jsdom exposes scrollTo but reports every call as "not implemented". Tests do
// not observe viewport position, so use the browser-shaped no-op and keep the
// suite free of false error output from router scroll restoration.
// oxlint-disable-next-line vitest/require-hook
Object.defineProperty(globalThis, 'scrollTo', {
  configurable: true,
  value: () => {},
});

// jsdom has no matchMedia; the theme resolver (lib/theme.ts) reads it on mount.
// Default to "no match" (→ dark). theme.test.ts stubs it per-case for OS-pref tests.
if (typeof globalThis !== 'undefined' && typeof globalThis.matchMedia !== 'function') {
  globalThis.matchMedia = (query: string) =>
    ({
      addEventListener: () => {},
      addListener: () => {},
      dispatchEvent: () => false,
      matches: false,
      media: query,
      onchange: null,
      removeEventListener: () => {},
      removeListener: () => {},
    }) as MediaQueryList;
}

afterEach(() => {
  cleanup();
});
