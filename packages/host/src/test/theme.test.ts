import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import {
  apply,
  clearTheme,
  resolve,
  setTheme,
  storedChoice,
  subscribeTheme,
  systemTheme,
  themeChoice,
} from '../lib/theme';
import { WELL_950 } from '../lib/theme-colors';

/** Stub `matchMedia` so the prefers-color-scheme query resolves deterministically. */
function mockOS(prefersLight: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    addEventListener: () => {},
    matches: q.includes('light') ? prefersLight : !prefersLight,
    media: q,
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  if (document.querySelector('meta[name="theme-color"]') === null) {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);
  }
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('theme resolution (MMR-74)', () => {
  it('storedChoice accepts only the valid values', () => {
    expect(storedChoice()).toBeNull();
    localStorage.setItem('mimir-theme', 'light');
    expect(storedChoice()).toBe('light');
    localStorage.setItem('mimir-theme', 'bogus');
    expect(storedChoice()).toBeNull();
  });

  it('systemTheme reads the OS preference', () => {
    mockOS(true);
    expect(systemTheme()).toBe('light');
    mockOS(false);
    expect(systemTheme()).toBe('dark');
  });

  it('resolve: an explicit pick wins over the OS', () => {
    mockOS(true); // OS says light
    localStorage.setItem('mimir-theme', 'dark');
    expect(resolve()).toBe('dark');
  });

  it('resolve: with no pick, follow the OS', () => {
    mockOS(true);
    expect(resolve()).toBe('light');
    mockOS(false);
    expect(resolve()).toBe('dark');
  });

  it('setTheme persists the pick and reflects it on the document', () => {
    setTheme('light');
    expect(localStorage.getItem('mimir-theme')).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    // The browser chrome takes the top bar's ground, so the two read as one band.
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
      WELL_950.light,
    );
  });

  it('apply sets data-theme without persisting', () => {
    apply('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('mimir-theme')).toBeNull();
  });
});

describe('returning to the system theme (MMR-733)', () => {
  it('clearTheme forgets the pick and applies the OS theme', () => {
    mockOS(true);
    setTheme('dark');
    expect(themeChoice()).toBe('dark');

    clearTheme();

    expect(localStorage.getItem('mimir-theme')).toBeNull();
    expect(themeChoice()).toBe('system');
    expect(resolve()).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
      WELL_950.light,
    );
  });

  it('tells subscribers about a pick and about clearing it', () => {
    mockOS(false);
    const listener = vi.fn();
    const unsubscribe = subscribeTheme(listener);
    setTheme('light');
    clearTheme();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    setTheme('dark');
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

/** A matchMedia stub whose OS preference can flip, firing the `change` listeners as a browser does. */
function controllableOS(prefersLight: boolean) {
  let light = prefersLight;
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', (q: string) => ({
    addEventListener: (_type: string, l: () => void) => listeners.add(l),
    get matches() {
      return q.includes('light') ? light : !light;
    },
    media: q,
    removeEventListener: (_type: string, l: () => void) => listeners.delete(l),
  }));
  return (next: boolean) => {
    light = next;
    for (const l of listeners) {
      l();
    }
  };
}

describe('following the OS (MMR-733)', () => {
  it('follows an OS change while no pick is stored, stops after a pick, and follows again after Match system', () => {
    const flip = controllableOS(false);
    const listener = vi.fn();
    const unsubscribe = subscribeTheme(listener);

    flip(true);
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(listener).toHaveBeenCalledTimes(1);

    setTheme('dark');
    listener.mockClear();
    flip(false);
    flip(true);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(listener).not.toHaveBeenCalled();

    clearTheme();
    listener.mockClear();
    flip(false);
    expect(document.documentElement.dataset.theme).toBe('dark');
    flip(true);
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });
});

const refuse = () => {
  throw new Error('storage disabled');
};

describe('storage that refuses writes (MMR-733)', () => {
  it('holds a pick, and a return to the system theme, for the session', () => {
    mockOS(true);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(refuse);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(refuse);
    try {
      setTheme('dark');
      expect(resolve()).toBe('dark');
      expect(themeChoice()).toBe('dark');
      expect(document.documentElement.dataset.theme).toBe('dark');

      clearTheme();
      expect(themeChoice()).toBe('system');
      expect(resolve()).toBe('light');
    } finally {
      vi.restoreAllMocks();
      // A write that lands ends the session hold, so later tests read storage again.
      clearTheme();
    }
  });
});
