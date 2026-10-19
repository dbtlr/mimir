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

// The data-layer test seam (MMR-537). A read or write that runs through a
// server function (api/fns/<area>.ts) is mocked by function, never by path:
//
//   vi.mock('../api/fns/shell');                      // every export is a vi.fn
//   import { projects } from '../api/fns/shell';
//   vi.mocked(projects).mockResolvedValue([engineProject({ id: 'MMR' })]);
//   expect(projects).toHaveBeenCalledWith({ data: { ... } });
//
// Answers are the Engine's own output types (engine-fixtures.ts), with `Date`
// instants. An area's helper serves a whole world at once (shell-fns.ts's
// `serveShell`); a new area adds its own `<area>-fns.ts` beside it. The
// host's own `/health` probe is the one read that is not an Engine method; it
// answers a fixed build here, and a test that cares mocks `../api/health`.
//
// A server function a test forgot to mock never reaches the host: every
// server function built in a test is a stub that refuses its call. A refused
// read only errors its query, which a test can pass straight through, so each
// refusal is also recorded and fails the test in afterEach.
const unmocked = vi.hoisted(() => ({ calls: [] as string[] }));
// oxlint-disable-next-line vitest/require-hook
vi.mock('@tanstack/react-start', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // A fresh stub per server function, so a module mock gives each its own vi.fn.
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- the factory runs hoisted; it owns its helpers
  const refuse = () => async () => {
    unmocked.calls.push(expect.getState().currentTestName ?? 'a test');
    throw new Error(
      'an unmocked server function was called: mock its module by function (see test/setup.ts)',
    );
  };
  const builder = { handler: refuse, middleware: () => builder, validator: () => builder };
  return { ...actual, createServerFn: () => builder };
});
// The host's server graph (its store and core) never loads in the browser test
// environment; no stubbed server function reaches it.
// oxlint-disable-next-line vitest/require-hook
vi.mock('../api/fns/engine', () => ({ engine: vi.fn() }));
// oxlint-disable-next-line vitest/require-hook
vi.mock('../api/health', () => ({
  fetchHealth: async () => ({ schema: 1, status: 'ok', version: '0.0.0' }),
}));

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

// jsdom has no scrollIntoView. The jump palette scrolls its highlighted row
// into view; tests do not observe scroll position, so a no-op stands in.
// oxlint-disable-next-line vitest/require-hook
Object.defineProperty(Element.prototype, 'scrollIntoView', {
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

// Keep test-environment costs out of the first test's waits (MMR-525).
// beforeAll runs after the test file's imports.
beforeAll(() => {
  // sonner injects its toast stylesheet into <head> on import, and jsdom
  // cascades every stylesheet on each getComputedStyle call, which role
  // queries make per element. The sheet has no `display: none` or
  // `visibility: hidden` rule, so no query result depends on it.
  for (const style of document.head.querySelectorAll('style')) {
    if (style.textContent.includes('[data-sonner-toaster]')) {
      style.remove();
    }
  }
  // Each file's fresh jsdom parses its default stylesheet on the first
  // getComputedStyle, and each worker loads ICU data on the first
  // Intl.DateTimeFormat. Pay both here, once, instead of inside whichever
  // test's findBy reaches them first.
  getComputedStyle(document.body).getPropertyValue('direction');
  new Intl.DateTimeFormat().resolvedOptions();
});

afterEach(() => {
  cleanup();
  const calls = unmocked.calls.splice(0);
  if (calls.length > 0) {
    throw new Error(
      `${calls[0] ?? 'a test'} called an unmocked server function ${String(calls.length)}×: mock its module by function (see test/setup.ts)`,
    );
  }
});
