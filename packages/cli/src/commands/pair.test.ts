/**
 * `mimir pair` (ADR 0038, MMR-579). Each case runs the real composition
 * against an in-process host: `/health` and the pairing routes over a real
 * token store, with the clock and the poll sleep injected so a wait costs no
 * time. The store edge refuses, so every case also proves pair never builds
 * the Engine. Questions are answered through the prompts library on a terminal
 * whose keys the case types.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { healthOf, readConfig, readCredentials, writeCredentials } from '@mimir/core';
import { createTestStore, pairingHost } from '@mimir/core/testing';
import type { TestStore } from '@mimir/core/testing';

import { createApp, remoteSource } from '../app';
import type { PairSource } from '../app';
import { boundClone } from '../testing/fixture';
import { runArgv } from '../testing/run';
import { VERSION } from '../version';
import { deviceFromHostname } from './pair';

const ORIGIN = 'http://mimir.example.test:64647';
const OTHER = 'https://elsewhere.example.test';
const STORE_CONFIG = '[store]\nbackend = "sqlite"\n';

/** What a case may arrange on the in-process host, and what it saw. */
type HostState = {
  /** The host's own version, which its `/health` reports. */
  version: string;
  /** Every request path the host received, in order. */
  paths: string[];
  polls: number;
  /** The request the host last filed. */
  filed: { user_code: string; poll_secret: string } | undefined;
  /** Approve the filed request once this many polls have been answered. */
  approveAt: number;
  /** Answer a request instead of the host, by path and poll count. */
  intercept:
    | ((path: string, polls: number) => Response | Promise<Response> | undefined)
    | undefined;
  /** Runs after each poll is answered, with the poll count. */
  afterPoll: ((polls: number) => Promise<void>) | undefined;
  /** Runs inside each sleep, with the sleep count. */
  onSleep: ((sleeps: number) => void) | undefined;
};

let fixture: TestStore;
let dir: string;
let configFile: string;
let credentialsFile: string;
let host: HostState;
let clock: number;
let sleeps: number;
let hostName: string;

beforeEach(async () => {
  fixture = await createTestStore();
  dir = mkdtempSync(join(tmpdir(), 'mimir-pair-'));
  configFile = join(dir, 'config', 'config.toml');
  credentialsFile = join(dir, 'config', 'credentials.toml');
  host = {
    afterPoll: undefined,
    approveAt: 1,
    filed: undefined,
    intercept: undefined,
    onSleep: undefined,
    paths: [],
    polls: 0,
    version: VERSION,
  };
  clock = Date.now();
  sleeps = 0;
  hostName = 'Valhalla.local';
});

afterEach(async () => {
  await fixture.close();
  rmSync(dir, { force: true, recursive: true });
});

/** The host's fetch: the real routes, with the case's interception and approval. */
async function hostFetch(input: string, init: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const path = new URL(request.url).pathname;
  host.paths.push(path);
  if (path === '/auth/pairing/poll') {
    host.polls += 1;
  }
  const response =
    (await host.intercept?.(path, host.polls)) ??
    (await pairingHost(fixture.tokens, host.version)(request));
  if (path === '/auth/pairing/requests' && response.ok) {
    host.filed = (await response.clone().json()) as NonNullable<HostState['filed']>;
  }
  if (path === '/auth/pairing/poll') {
    if (host.afterPoll === undefined) {
      if (host.polls === host.approveAt && host.filed !== undefined) {
        await fixture.tokens.approve(host.filed.user_code);
      }
    } else {
      await host.afterPoll(host.polls);
    }
  }
  return response;
}

/** A sleep that advances the injected clock instead of waiting. */
async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  clock += ms;
  sleeps += 1;
  host.onSleep?.(sleeps);
  signal.throwIfAborted();
}

/** A local-store edge pair must never reach. */
const opensStore = (): never => {
  throw new Error('pair opened a local store');
};

const pairEdges = (): PairSource => ({
  configFile,
  credentialsFile,
  fetch: hostFetch,
  hostname: () => hostName,
  now: () => clock,
  sleep,
});

const machineEdges = () => ({
  cwd: dir,
  doctor: opensStore,
  openPostgres: opensStore,
  openSqlite: opensStore,
  pair: pairEdges(),
  readConfig: () => readConfig(configFile),
  readStdin: () => Promise.resolve(''),
});

/** The CLI with a store that must stay closed. */
const pairApp = () =>
  createApp({ git: boundClone('MMR'), machine: machineEdges(), store: opensStore });

type RunOptions = Parameters<typeof runArgv>[2];

const pair = (argv: string[], opts?: RunOptions) => runArgv(pairApp(), ['pair', ...argv], opts);

/** Put a config file in place, creating its directory. */
async function seedConfig(text: string): Promise<void> {
  await Bun.write(configFile, text);
}

const mode = (file: string) => statSync(file).mode & 0o777;

/** Nothing about the pairing was written. */
function expectUntouched(config?: string): void {
  expect(existsSync(credentialsFile)).toBe(false);
  if (config === undefined) {
    expect(existsSync(configFile)).toBe(false);
  } else {
    expect(readFileSync(configFile, 'utf8')).toBe(config);
  }
}

/** The token and poll secret appear in no output. */
function expectNoSecrets(run: { stdout: string; stderr: string }, token?: string): void {
  const secrets = [host.filed?.poll_secret, token].filter(
    (value): value is string => value !== undefined,
  );
  for (const secret of secrets) {
    expect(run.stdout).not.toContain(secret);
    expect(run.stderr).not.toContain(secret);
  }
}

test('pairing writes the credentials and the host url, and echoes the result', async () => {
  const run = await pair([ORIGIN, '--device', 'laptop']);
  expect(run.exitCode).toBe(0);
  expect(run.stdout).toBe(`[ok] paired as laptop with ${ORIGIN} (host ${VERSION})\n`);

  const credentials = readCredentials(ORIGIN, credentialsFile);
  expect(credentials).toMatchObject({ device: 'laptop', origin: ORIGIN });
  expect(Date.parse(credentials.issuedAt)).toBe(clock);
  expect(mode(credentialsFile)).toBe(0o600);
  expect(await fixture.tokens.verify(credentials.token)).toBeTruthy();
  expect(readConfig(configFile).host).toEqual({ url: ORIGIN });

  const code = host.filed?.user_code ?? '';
  expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  expect(run.stderr).toContain(`pairing code ${code}`);
  expect(run.stderr).toContain(`approve with mimir-host approve ${code} on the host`);
  expect(run.stderr).toContain(`${ORIGIN}/pair?code=${code}`);
  expect(run.stderr).toMatch(/expires at \d{4}-\d{2}-\d{2} \d{2}:\d{2} /);
  expect(run.stderr).toContain('Waiting for approval');
  expectNoSecrets(run, credentials.token);
});

test('pairing polls at the interval the host states', async () => {
  // Approved after the third poll answers pending, so the fourth collects the token.
  host.approveAt = 3;
  const before = clock;
  const run = await pair([ORIGIN, '--device', 'laptop']);
  expect(run.exitCode).toBe(0);
  expect(host.polls).toBe(4);
  expect(clock - before).toBe(4 * 2000);
});

test.each([
  ['json', ['-f', 'json']],
  ['jsonl', ['-f', 'jsonl']],
])('the %s format prints one record and never the token', async (format, flags) => {
  const run = await pair([ORIGIN, '--device', 'laptop', ...flags]);
  expect(run.exitCode).toBe(0);
  expect(JSON.parse(run.stdout)).toEqual({
    device: 'laptop',
    host_version: VERSION,
    origin: ORIGIN,
  });
  if (format === 'jsonl') {
    expect(run.stdout.trim().split('\n')).toHaveLength(1);
  }
  expectNoSecrets(run, readCredentials(ORIGIN, credentialsFile).token);
});

test('the device defaults to the hostname first label, lowercased', async () => {
  const run = await pair([ORIGIN]);
  expect(run.stdout).toContain(`paired as valhalla with ${ORIGIN}`);
});

test('--device is taken verbatim', async () => {
  const run = await pair([ORIGIN, '--device', 'MyLaptop']);
  expect(run.stdout).toContain('paired as MyLaptop with');
});

test('a hostname with no first label asks for --device and files nothing', async () => {
  hostName = '.local';
  const run = await pair([ORIGIN]);
  expect(run.exitCode).toBe(2);
  expect(run.stderr).toContain('pass --device <name>');
  expect(host.paths).toEqual(['/health']);
  expectUntouched();
});

test.each([
  ['Valhalla.local', 'valhalla'],
  ['MacBook-Pro', 'macbook-pro'],
  ['host.sub.example.com', 'host'],
  ['  Spaced ', 'spaced'],
  ['.local', ''],
  ['', ''],
])('the hostname %j names the device %j', (hostname, device) => {
  expect(deviceFromHostname(hostname)).toBe(device);
});

test('a url that is not http or https is a usage error and contacts nothing', async () => {
  const run = await pair(['ftp://mimir.example.test']);
  expect(run.exitCode).toBe(2);
  expect(run.stderr).toContain('is not an http or https URL');
  expect(host.paths).toEqual([]);
});

test('a url with a path is reduced to its origin', async () => {
  const run = await pair([`${ORIGIN}/console/?x=1`, '--device', 'laptop']);
  expect(run.exitCode).toBe(0);
  expect(readConfig(configFile).host?.url).toBe(ORIGIN);
});

test('a missing url outside a terminal is a usage error with the remedy', async () => {
  const run = await pair([]);
  expect(run.exitCode).toBe(2);
  expect(run.stderr).toContain('pair needs the host URL');
  expect(run.stderr).toContain('mimir pair <url>');
  expect(host.paths).toEqual([]);
});

test('--no-input refuses a missing url even at a terminal', async () => {
  const run = await pair(['--no-input'], { interactive: true, tty: true });
  expect(run.exitCode).toBe(2);
  expect(run.stderr).toContain('mimir pair <url>');
});

test('a missing url at a terminal is asked for, and pairing goes on with the answer', async () => {
  const run = await pair(['--device', 'laptop'], {
    interactive: true,
    keys: `${ORIGIN}/ignored\r`,
    tty: true,
  });
  expect(run.exitCode).toBe(0);
  expect(run.stderr).toContain('Host URL');
  expect(readConfig(configFile).host?.url).toBe(ORIGIN);
});

test('a config that declares [store] refuses with the migration steps and writes nothing', async () => {
  await seedConfig(STORE_CONFIG);
  const run = await pair([ORIGIN, '--device', 'laptop']);
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain('declares [store]');
  expect(run.stderr).toContain('mimir store export');
  expect(run.stderr).toContain('mimir-host store import');
  expect(run.stderr).toContain('remove [store]');
  expect(run.stderr).toContain(`mimir pair ${ORIGIN}`);
  expect(host.paths).toEqual([]);
  expectUntouched(STORE_CONFIG);
});

test('a denied request writes nothing and says to pair again', async () => {
  host.afterPoll = async () => {
    await fixture.tokens.deny(host.filed?.user_code ?? '');
  };
  const run = await pair([ORIGIN, '--device', 'laptop']);
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain(`the host at ${ORIGIN} denied the pairing request for laptop`);
  expect(run.stderr).toContain('run mimir pair again');
  expectUntouched();
});

test('a request the host reports expired writes nothing', async () => {
  host.intercept = (path) =>
    path === '/auth/pairing/poll' ? Response.json({ status: 'expired' }) : undefined;
  const run = await pair([ORIGIN, '--device', 'laptop']);
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain('expired before the host approved it');
  expect(run.stderr).toContain('run mimir pair again');
  expectUntouched();
});

test('a request still pending at its expiry ends the wait and writes nothing', async () => {
  host.approveAt = Number.POSITIVE_INFINITY;
  const run = await pair([ORIGIN, '--device', 'laptop']);
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain('expired before the host approved it');
  expect(host.polls).toBeGreaterThan(100);
  expectUntouched();
});

test.each([
  [
    'below the minimum',
    () => {
      host.intercept = (path) =>
        path === '/health'
          ? Response.json({ ...healthOf(VERSION), minClient: '99.0.0' })
          : undefined;
    },
    'update this CLI',
  ],
  [
    'newer than the host',
    () => {
      host.version = '0.1.0';
    },
    'update the host first',
  ],
  [
    'malformed',
    () => {
      host.version = 'not-a-version';
    },
    'released versions',
  ],
])('a host window %s refuses before filing a request', async (_name, arrange, remedy) => {
  arrange();
  const run = await pair([ORIGIN, '--device', 'laptop']);
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain(remedy);
  expect(host.paths).toEqual(['/health']);
  expectUntouched();
});

test('a host that cannot be reached for /health refuses with its remedy', async () => {
  host.intercept = () => {
    throw new TypeError('connection refused');
  };
  const run = await pair([ORIGIN, '--device', 'laptop']);
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain(`could not reach the host at ${ORIGIN}`);
  expectUntouched();
});

test('pairing again with the same origin replaces both files without asking', async () => {
  await seedConfig(`# my config\n[host]\nurl = "${ORIGIN}"\n`);
  writeCredentials(
    { device: 'laptop', issuedAt: '2026-10-01T00:00:00.000Z', origin: ORIGIN, token: 'old-token' },
    credentialsFile,
  );
  // A terminal with no keys typed: any question would fail the run.
  const run = await pair([ORIGIN, '--device', 'laptop'], { interactive: true, tty: true });
  expect(run.exitCode).toBe(0);
  const credentials = readCredentials(ORIGIN, credentialsFile);
  expect(credentials.token).not.toBe('old-token');
  expect(credentials.issuedAt).not.toBe('2026-10-01T00:00:00.000Z');
  expect(readFileSync(configFile, 'utf8')).toBe(`# my config\n[host]\nurl = "${ORIGIN}"\n`);
  expect(run.stderr).not.toContain('replacing the pairing');
});

test('a different origin with --yes proceeds and warns which device to unpair', async () => {
  await seedConfig(`[host]\nurl = "${OTHER}"\n`);
  const run = await pair([ORIGIN, '--device', 'laptop', '--yes'], { interactive: true, tty: true });
  expect(run.exitCode).toBe(0);
  expect(run.stderr).toContain(`replacing the pairing with ${OTHER}`);
  expect(run.stderr).toContain(`unpair laptop on ${OTHER} (mimir-host unpair laptop)`);
  expect(readConfig(configFile).host?.url).toBe(ORIGIN);
  expect(readCredentials(ORIGIN, credentialsFile).device).toBe('laptop');
});

test('a different origin outside a terminal proceeds with the same warning', async () => {
  await seedConfig(`[host]\nurl = "${OTHER}"\n`);
  const run = await pair([ORIGIN, '--device', 'laptop']);
  expect(run.exitCode).toBe(0);
  expect(run.stderr).toContain(`replacing the pairing with ${OTHER}`);
  expect(run.stderr).toContain(`unpair laptop on ${OTHER} (mimir-host unpair laptop)`);
  expect(readConfig(configFile).host?.url).toBe(ORIGIN);
});

test('--no-input at a terminal proceeds without the question', async () => {
  await seedConfig(`[host]\nurl = "${OTHER}"\n`);
  const run = await pair([ORIGIN, '--device', 'laptop', '--no-input'], {
    interactive: true,
    tty: true,
  });
  expect(run.exitCode).toBe(0);
  expect(run.stderr).toContain(`replacing the pairing with ${OTHER}`);
});

test('declining the replacement at a terminal writes nothing and files no request', async () => {
  const config = `[host]\nurl = "${OTHER}"\n`;
  await seedConfig(config);
  const run = await pair([ORIGIN, '--device', 'laptop'], {
    interactive: true,
    keys: 'n\r',
    tty: true,
  });
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain(`Replace the pairing with ${OTHER}?`);
  expect(run.stderr).toContain(`the pairing with ${OTHER} is unchanged`);
  expect(host.paths).toEqual(['/health']);
  expectUntouched(config);
});

test('accepting the replacement at a terminal pairs', async () => {
  await seedConfig(`[host]\nurl = "${OTHER}"\n`);
  const run = await pair([ORIGIN, '--device', 'laptop'], {
    interactive: true,
    keys: 'y\r',
    tty: true,
  });
  expect(run.exitCode).toBe(0);
  expect(run.stderr).toContain(`Replace the pairing with ${OTHER}?`);
  expect(readConfig(configFile).host?.url).toBe(ORIGIN);
});

test('a broken [host] and unreadable credentials are what pairing repairs, without the Engine', async () => {
  await seedConfig('[host]\nurl = "not a url"\n');
  await Bun.write(credentialsFile, 'this is not toml [');
  const config = readConfig(configFile);
  const app = createApp({
    git: boundClone('MMR'),
    machine: machineEdges(),
    remote: remoteSource({ config, configFile, credentialsFile }),
  });
  const run = await runArgv(app, ['pair', ORIGIN, '--device', 'laptop']);
  expect(run.exitCode).toBe(0);
  expect(readConfig(configFile).host?.url).toBe(ORIGIN);
  expect(readCredentials(ORIGIN, credentialsFile).device).toBe('laptop');
});

test('a poll that fails and recovers is noted once and the wait goes on', async () => {
  host.approveAt = 4;
  host.intercept = (path, polls) =>
    path === '/auth/pairing/poll' && polls < 3
      ? Response.json({ error: 'bad gateway' }, { status: 502 })
      : undefined;
  const run = await pair([ORIGIN, '--device', 'laptop']);
  expect(run.exitCode).toBe(0);
  expect(run.stderr.match(/host unreachable, still waiting until \d{2}:\d{2}/g)).toHaveLength(1);
  expect(readConfig(configFile).host?.url).toBe(ORIGIN);
});

test('a host unreachable until the request lapses writes nothing', async () => {
  host.intercept = (path) => {
    if (path === '/auth/pairing/poll') {
      throw new TypeError('connection refused');
    }
    return undefined;
  };
  const run = await pair([ORIGIN, '--device', 'laptop']);
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain('host unreachable, still waiting until');
  expect(run.stderr).toContain('expired before the host approved it');
  expectUntouched();
});

test('a definite poll failure ends the wait at once', async () => {
  host.intercept = (path) =>
    path === '/auth/pairing/poll' ? Response.json({ error: 'nope' }, { status: 400 }) : undefined;
  const run = await pair([ORIGIN, '--device', 'laptop']);
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain('run mimir pair again');
  expect(host.polls).toBe(1);
  expectUntouched();
});

test('Ctrl-C during the wait resolves 130 and writes nothing', async () => {
  const controller = new AbortController();
  host.approveAt = Number.POSITIVE_INFINITY;
  host.onSleep = (count) => {
    if (count === 2) {
      controller.abort();
    }
  };
  const run = await pair([ORIGIN, '--device', 'laptop'], { signal: controller.signal });
  expect(run.exitCode).toBe(130);
  expectUntouched();
  expectNoSecrets(run);
});

test('a rate limit at filing refuses with the wait and is not retried', async () => {
  host.intercept = (path) =>
    path === '/auth/pairing/requests'
      ? Response.json(
          { error: 'too many pairing requests' },
          { headers: { 'retry-after': '42' }, status: 429 },
        )
      : undefined;
  const run = await pair([ORIGIN, '--device', 'laptop']);
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain('too many pairing requests');
  expect(run.stderr).toContain('try again in 42 seconds');
  expect(host.paths).toEqual(['/health', '/auth/pairing/requests']);
  expectUntouched();
});

test('an approved request awaiting collection refuses with the host message and hint', async () => {
  const waiting = await fixture.tokens.request('laptop');
  await fixture.tokens.approve(waiting.user_code);
  const run = await pair([ORIGIN, '--device', 'laptop']);
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain('approved pairing request awaiting collection');
  expect(run.stderr).toContain('deny or unpair the device on the host');
  expectUntouched();
});

test('a device name the host refuses names the rule', async () => {
  const run = await pair([ORIGIN, '--device', 'x'.repeat(129)]);
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain('the host refused the device name');
  expect(run.stderr).toContain('1 to 128 characters');
  expectUntouched();
});

test.each([
  ['an inline host table', 'host = { url = "http://old.test" }\n'],
  ['a dotted host key', 'host.url = "http://old.test"\n'],
  ['malformed TOML', '[host\nurl = "x"\n'],
])('%s refuses before any request is filed', async (_name, config) => {
  await seedConfig(config);
  const run = await pair([ORIGIN, '--device', 'laptop']);
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toMatch(/cannot be edited in place|is not valid TOML/);
  expect(host.paths).toEqual([]);
  expectUntouched(config);
});

test('a config that becomes uneditable during the wait still refuses at the write', async () => {
  host.onSleep = (count) => {
    if (count === 1) {
      writeFileSync(configFile, 'host = { url = "http://old.test" }\n');
    }
  };
  await seedConfig('');
  const run = await pair([ORIGIN, '--device', 'laptop']);
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain('cannot be edited in place');
  expect(run.stderr).not.toContain('UNHANDLED');
});

test('the replacement names the device the old host recorded', async () => {
  await seedConfig(`[host]\nurl = "${OTHER}"\n`);
  writeCredentials(
    { device: 'oldname', issuedAt: '2026-10-01T00:00:00.000Z', origin: OTHER, token: 'old-token' },
    credentialsFile,
  );
  const run = await pair([ORIGIN, '--device', 'laptop', '--yes']);
  expect(run.exitCode).toBe(0);
  expect(run.stderr).toContain(`unpair oldname on ${OTHER} (mimir-host unpair oldname)`);
  expect(run.stderr).not.toContain('old-token');
});

test('the confirm question names the recorded device too', async () => {
  await seedConfig(`[host]\nurl = "${OTHER}"\n`);
  writeCredentials(
    { device: 'oldname', issuedAt: '2026-10-01T00:00:00.000Z', origin: OTHER, token: 'old-token' },
    credentialsFile,
  );
  const run = await pair([ORIGIN, '--device', 'laptop'], {
    interactive: true,
    keys: 'n\r',
    tty: true,
  });
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain(`unpair oldname on ${OTHER} (mimir-host unpair oldname)`);
});

test('credentials recorded for another origin fall back to the new device name', async () => {
  await seedConfig(`[host]\nurl = "${OTHER}"\n`);
  writeCredentials(
    {
      device: 'stale',
      issuedAt: '2026-10-01T00:00:00.000Z',
      origin: 'https://third.example.test',
      token: 'old-token',
    },
    credentialsFile,
  );
  const run = await pair([ORIGIN, '--device', 'laptop', '--yes']);
  expect(run.exitCode).toBe(0);
  expect(run.stderr).toContain(`unpair laptop on ${OTHER} (mimir-host unpair laptop)`);
  expect(run.stderr).not.toContain('stale');
});

test('the pair help lists the url, --device, --yes, and --no-input', async () => {
  const run = await pair(['--help']);
  expect(run.exitCode).toBe(0);
  for (const word of ['[url]', '--device', '-y, --yes']) {
    expect(run.stdout).toContain(word);
  }
  expect(run.stdout).toContain('--no-input');
});
