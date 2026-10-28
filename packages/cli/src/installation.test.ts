import { expect, test } from 'bun:test';

import { Application } from '@loomcli/core';
import { INSTALLATION_PROTOCOL_RESPONSE } from '@mimir/core';

import { createApp } from './app';
import { installationInstallCommand } from './commands/installation';
import { boundClone } from './testing/fixture';
import { runArgv } from './testing/run';

/**
 * The installer's handshake (ADR 0031): core probes a candidate with
 * `installation-protocol`, and the dev sandboxes call `installation-install`.
 * Neither shows in help, and neither opens the store.
 */
const app = () =>
  createApp({
    git: boundClone(undefined),
    store: () => Promise.reject(new Error('the store must stay closed')),
  });

test('installation-protocol prints the line core probes for, exit 0', async () => {
  const run = await runArgv(app(), ['installation-protocol']);
  expect(run).toEqual({ exitCode: 0, stderr: '', stdout: `${INSTALLATION_PROTOCOL_RESPONSE}\n` });
  expect(INSTALLATION_PROTOCOL_RESPONSE).toBe('{"installationProtocol":1}');
});

test('installation-install refuses a source run with core message, exit 2', async () => {
  const run = await runArgv(app(), ['installation-install', '--target', '/x']);
  expect(run.exitCode).toBe(2);
  expect(run.stdout).toBe('');
  expect(run.stderr).toContain('installation-install requires a compiled candidate.');
});

test('installation-install hands core the options it was given as --name value pairs', async () => {
  const received: string[][] = [];
  const probe = new Application('probe', { description: 'A probe.' }).command(
    installationInstallCommand({
      installation: {
        install: (args) => {
          received.push(args);
        },
        protocolResponse: INSTALLATION_PROTOCOL_RESPONSE,
      },
    }),
  );
  const run = await runArgv(probe, [
    'installation-install',
    '--target',
    '/t',
    '--mode',
    'live',
    '--config',
    '/g',
    '--data',
    '/d',
    '--cache',
    '/c',
  ]);
  expect(run.exitCode).toBe(0);
  expect(received).toEqual([
    ['--target', '/t', '--mode', 'live', '--config', '/g', '--data', '/d', '--cache', '/c'],
  ]);
});

test.each([['-h'], ['--help']])('neither command shows in %s', async (flag) => {
  const run = await runArgv(app(), [flag]);
  expect(run.exitCode).toBe(0);
  expect(run.stdout).not.toContain('installation');
});
