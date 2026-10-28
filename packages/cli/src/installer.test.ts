import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

import { applicationDirectory } from '@loomcli/core';
import { scriptRecordDirectory } from '@mimir/core';

import { createApp } from './app';
import { application } from './application';
import { boundClone } from './testing/fixture';
import { runArgv } from './testing/run';

/**
 * The installer is `loom init`'s managed `install.sh` (MMR-554), rendered for
 * this package's `bin` name, GitHub repository, and the Application's
 * `postInstall`. It installs Loom-built releases; the root `install.sh` stays for
 * older versions until the first stable Loom-built release. Re-render it with `bun run --cwd packages/cli loom init
 * --only install`; an edit by hand reads as drift.
 */
const script = new URL('../install.sh', import.meta.url);

test('install.sh is the installer loom init manages, undrifted', () => {
  const text = readFileSync(script, 'utf8');
  const [shebang = '', header = '', ...rest] = text.split('\n');
  const checksum = /^# Managed by loom init\. sha256:(?<hex>[a-f0-9]{64})$/.exec(header)?.groups
    ?.hex;
  const content = [shebang, ...rest].join('\n');
  expect(checksum).toBe(createHash('sha256').update(content).digest('hex'));
  expect(text).toContain("  app='mimir'\n  repository='dbtlr/mimir'\n");
  expect(statSync(script).mode & 0o111).toBe(0o111);
});

test('the installer registers the MCP server with Claude Code once it has installed the binary', () => {
  expect(application.inspect().postInstall).toEqual({
    command: ['mcp', 'install', '--agent', 'claude'],
    message: expect.stringContaining('mimir bind'),
  });
  const text = readFileSync(script, 'utf8');
  expect(text).toContain("'mcp' 'install' '--agent' 'claude'");
  expect(text).toContain('--skip-post-install');
});

test.each<[string, Record<string, string>]>([
  ['darwin', { HOME: '/home/a' }],
  ['linux', { HOME: '/home/a' }],
  ['linux', { HOME: '/home/a', XDG_STATE_HOME: '/state' }],
  ['linux', { HOME: '/home/a', XDG_STATE_HOME: 'relative' }],
  ['darwin', {}],
  ['darwin', { HOME: '/home/a', XDG_STATE_HOME: '/state' }],
  ['linux', { XDG_STATE_HOME: '/state' }],
])('core reads the installation record where Loom keeps it (%s, %o)', (platform, env) => {
  const loom = applicationDirectory('installation', 'mimir', {
    env,
    home: env.HOME ?? '',
    platform,
  });
  expect(scriptRecordDirectory(env, platform)).toBe('path' in loom ? loom.path : undefined);
});

test('self-update refuses a run that is not a release binary, before the store opens', async () => {
  let opened = false;
  const app = createApp({
    git: boundClone('MMR'),
    store: () => {
      opened = true;
      return Promise.reject(new Error('the store must stay closed'));
    },
  });
  const run = await runArgv(app, ['self-update']);
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain('was not built as a release binary');
  expect(opened).toBe(false);
});

test.each([
  [['self-update', '--next'], "'--next' is now a channel: mimir self-update --channel next"],
  [
    ['self-update', '--tag', 'v1.4.0'],
    'self-update takes the release version as its argument: mimir self-update <version>',
  ],
])("the old CLI's self-update selector %p redirects to Loom's", async (argv, hint) => {
  const app = createApp({
    git: boundClone('MMR'),
    store: () => Promise.reject(new Error('the store must stay closed')),
  });
  const run = await runArgv(app, argv);
  expect(run.exitCode).toBe(2);
  expect(run.stderr).toContain(hint);
});
