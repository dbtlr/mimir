/// <reference types="vitest/jsdom" />

// Global test setup (matchers + afterEach cleanup), not a test body.
// oxlint-disable vitest/require-top-level-describe
// side-effect import: registers jest-dom matchers on vitest's expect
// oxlint-disable-next-line import/no-unassigned-import
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';

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
