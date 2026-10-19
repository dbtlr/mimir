import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { adoptionPaths, readScriptInstallation, scriptRecordDirectory } from './script-record';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const hex = 'a'.repeat(64);

/** A home whose Loom installation record holds `content` as install.json, on linux. */
function recorded(content: string) {
  const home = mkdtempSync(join(tmpdir(), 'mimir-script-record-'));
  roots.push(home);
  const record = join(home, '.local', 'state', 'mimir', 'installation');
  mkdirSync(record, { recursive: true });
  writeFileSync(join(record, 'install.json'), content);
  return { HOME: home };
}

test('the record directory follows the platform state directory', () => {
  expect(scriptRecordDirectory({ HOME: '/home/a' }, 'darwin')).toBe(
    '/home/a/Library/Application Support/mimir/installation',
  );
  expect(scriptRecordDirectory({ HOME: '/home/a' }, 'linux')).toBe(
    '/home/a/.local/state/mimir/installation',
  );
  expect(scriptRecordDirectory({ HOME: '/home/a', XDG_STATE_HOME: '/state' }, 'linux')).toBe(
    '/state/mimir/installation',
  );
  // A relative XDG_STATE_HOME is ignored, as the XDG rules say.
  expect(scriptRecordDirectory({ HOME: '/home/a', XDG_STATE_HOME: 'state' }, 'linux')).toBe(
    '/home/a/.local/state/mimir/installation',
  );
});

test('no record directory resolves without an absolute home', () => {
  expect(scriptRecordDirectory({}, 'darwin')).toBeUndefined();
  expect(scriptRecordDirectory({ HOME: 'relative' }, 'linux')).toBeUndefined();
});

test('a script installation reads back its path and digest', () => {
  const env = recorded(
    `{"format":1,"method":"script","path":"/bin/mimir","digest":"sha256:${hex}"}\n`,
  );
  expect(readScriptInstallation(env, 'linux')).toEqual({ path: '/bin/mimir', sha256: hex });
});

test.each([
  ['no file', undefined],
  ['malformed JSON', '{'],
  [
    'an unknown format',
    `{"format":2,"method":"script","path":"/bin/mimir","digest":"sha256:${hex}"}`,
  ],
  [
    'another installer',
    `{"format":1,"method":"brew","path":"/bin/mimir","digest":"sha256:${hex}"}`,
  ],
  ['a relative path', `{"format":1,"method":"script","path":"mimir","digest":"sha256:${hex}"}`],
  ['a bare digest', `{"format":1,"method":"script","path":"/bin/mimir","digest":"${hex}"}`],
])('%s reads as no script installation', (_name, content) => {
  const env =
    content === undefined
      ? { HOME: mkdtempSync(join(tmpdir(), 'mimir-script-record-')) }
      : recorded(content);
  roots.push(env.HOME);
  expect(readScriptInstallation(env, 'linux')).toBeUndefined();
});

const homeDefaults = {
  paths: {
    cache: '/home/a/.cache/mimir',
    config: '/home/a/.config/mimir',
    data: '/home/a/.local/share/mimir',
  },
};

test.each([
  ['no XDG roots', 'linux', { HOME: '/home/a' }],
  [
    'roots set to their defaults',
    'linux',
    {
      HOME: '/home/a',
      XDG_CACHE_HOME: '/home/a/.cache/',
      XDG_CONFIG_HOME: '/home/a/.config',
      XDG_DATA_HOME: '/home/a/.local/share',
      XDG_STATE_HOME: '/home/a/.local/state',
    },
  ],
  ['empty roots, which are unset', 'linux', { HOME: '/home/a', XDG_DATA_HOME: '' }],
  // macOS keeps Loom's record under HOME, so the state root is not a binding there.
  ['a state root on macOS', 'darwin', { HOME: '/home/a', XDG_STATE_HOME: '/tmp/state' }],
])('an adoption with %s binds the home defaults', (_name, platform, env) => {
  expect(adoptionPaths(env, platform)).toEqual(homeDefaults);
});

test.each([
  ['XDG_DATA_HOME', 'linux', { HOME: '/home/a', XDG_DATA_HOME: '/tmp/data' }],
  ['XDG_CONFIG_HOME', 'darwin', { HOME: '/home/a', XDG_CONFIG_HOME: '/tmp/config' }],
  ['XDG_CACHE_HOME', 'linux', { HOME: '/home/a', XDG_CACHE_HOME: '/tmp/cache' }],
  ['XDG_STATE_HOME', 'linux', { HOME: '/home/a', XDG_STATE_HOME: '/tmp/state' }],
  // A relative root is not guessed at: it refuses rather than falling back.
  ['XDG_DATA_HOME', 'linux', { HOME: '/home/a', XDG_DATA_HOME: 'relative' }],
])('a run that redirects %s adopts nothing', (variable, platform, env) => {
  const adoption = adoptionPaths(env, platform);
  expect(adoption).not.toHaveProperty('paths');
  expect(adoption).toHaveProperty('refusal', expect.stringContaining(variable));
});

test('a redirected data root is unset, or recorded by the root install.sh', () => {
  expect(adoptionPaths({ HOME: '/home/a', XDG_DATA_HOME: '/tmp/data' }, 'linux')).toEqual({
    refusal: 'XDG_DATA_HOME is /tmp/data, not its default /home/a/.local/share',
    remedy:
      'To adopt the $HOME defaults, run it once with XDG_DATA_HOME unset; if the directories under XDG_DATA_HOME hold your real config, data, or cache, install with the root install.sh instead, which records them',
  });
});

// Loom's install.sh writes its record under an absolute XDG_STATE_HOME, so a
// run with it unset would find no record: the record must move first.
test('a redirected state root on linux re-runs Loom install.sh before unsetting it', () => {
  expect(adoptionPaths({ HOME: '/home/a', XDG_STATE_HOME: '/tmp/state' }, 'linux')).toEqual({
    refusal: 'XDG_STATE_HOME is /tmp/state, not its default /home/a/.local/state',
    remedy:
      "To adopt the $HOME defaults, re-run Loom's install.sh with XDG_STATE_HOME unset so its record moves to the default, then run mimir once with XDG_STATE_HOME unset, or install with the root install.sh instead",
  });
});

test('a relative state root leaves the record at its default, so unsetting it is enough', () => {
  expect(adoptionPaths({ HOME: '/home/a', XDG_STATE_HOME: 'state' }, 'linux')).toHaveProperty(
    'remedy',
    'To adopt the $HOME defaults, run it once with XDG_STATE_HOME unset, or install with the root install.sh instead',
  );
});

test('one refusal names every redirected root', () => {
  const env = {
    HOME: '/home/a',
    XDG_CACHE_HOME: '/tmp/cache',
    XDG_CONFIG_HOME: '/tmp/config',
    XDG_STATE_HOME: '/tmp/state',
  };
  expect(adoptionPaths(env, 'linux')).toEqual({
    refusal:
      'XDG_CACHE_HOME is /tmp/cache, not its default /home/a/.cache; XDG_CONFIG_HOME is /tmp/config, not its default /home/a/.config; XDG_STATE_HOME is /tmp/state, not its default /home/a/.local/state',
    remedy:
      "To adopt the $HOME defaults, re-run Loom's install.sh with XDG_STATE_HOME unset so its record moves to the default, then run mimir once with XDG_CACHE_HOME, XDG_CONFIG_HOME, and XDG_STATE_HOME unset; if the directories under XDG_CACHE_HOME and XDG_CONFIG_HOME hold your real config, data, or cache, install with the root install.sh instead, which records them",
  });
});

test('a home that is not absolute adopts nothing', () => {
  expect(adoptionPaths({ HOME: 'relative' }, 'linux')).toEqual({
    refusal: 'HOME is not an absolute path',
    remedy: 'To adopt the $HOME defaults, run it once with HOME set to an absolute path',
  });
});
