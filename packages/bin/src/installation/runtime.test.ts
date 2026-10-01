import { afterAll, beforeAll, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installBinary, registerInstallation } from './index';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'mimir-install-runtime-')));
const binary = join(root, 'candidate');
const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
beforeAll(async () => {
  const probe = join(root, 'probe.ts');
  writeFileSync(
    probe,
    `import { runtimePaths, IS_PRODUCTION, supervisorScope } from ${JSON.stringify(join(sourceRoot, 'env.ts'))};\nif (process.argv[2] === 'installation-protocol') console.log('{"installationProtocol":1}'); else console.log(JSON.stringify({paths:runtimePaths(),live:IS_PRODUCTION,scope:supervisorScope()}));`,
  );
  const build = Bun.spawn(
    [
      process.execPath,
      'build',
      probe,
      '--compile',
      '--define',
      'MIMIR_BUILD_PROFILE="production"',
      '--outfile',
      binary,
    ],
    { stderr: 'pipe', stdout: 'pipe' },
  );
  if ((await build.exited) !== 0) {
    throw new Error(await new Response(build.stderr).text());
  }
});
afterAll(() => rmSync(root, { force: true, recursive: true }));
async function run(executable = binary) {
  const child = Bun.spawn([executable], {
    env: {
      ...process.env,
      MIMIR_SANDBOX_AUTHORITY: undefined,
      XDG_CONFIG_HOME: join(root, 'live-config'),
      XDG_DATA_HOME: join(root, 'live-data'),
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  return {
    code: await child.exited,
    stderr: await new Response(child.stderr).text(),
    stdout: await new Response(child.stdout).text(),
  };
}
test('compiled production profile alone cannot select live paths', async () => {
  const result = await run();
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    live: false,
    paths: {
      cache: join(root, '.dev/cache/mimir'),
      config: join(root, '.dev/config/mimir'),
      data: join(root, '.dev'),
    },
    // No installation: the supervisor fence grants no unit at all.
    scope: { kind: 'none' },
  });
});
test('registered compiled executable ignores ambient XDG and rejects replacement', async () => {
  const installed = join(root, 'installed');
  mkdirSync(installed);
  const executable = join(installed, 'mimir');
  copyFileSync(binary, executable);
  const paths = {
    cache: join(root, 'bound/cache'),
    config: join(root, 'bound/config'),
    data: join(root, 'bound/data'),
  };
  registerInstallation({ executable, mode: 'live', paths });
  expect(JSON.parse((await run(executable)).stdout)).toEqual({
    live: true,
    paths,
    scope: { kind: 'live' },
  });
  const copied = join(root, 'copied');
  copyFileSync(executable, copied);
  copyFileSync(`${executable}.installation.json`, `${copied}.installation.json`);
  const denied = await run(copied);
  expect(denied.code).not.toBe(0);
  expect(denied.stderr).toContain('does not match');
});

test('a registered sandbox installation is scoped to its own sandbox id', async () => {
  const sandboxRoot = join(root, 'vault-sandbox');
  const paths = {
    cache: join(sandboxRoot, 'cache', 'mimir'),
    config: join(sandboxRoot, 'config', 'mimir'),
    data: join(sandboxRoot, 'data', 'mimir'),
  };
  for (const path of Object.values(paths)) {
    mkdirSync(path, { recursive: true });
  }
  const id = '1234abcd-1234-4234-8234-123456789012';
  const sandboxAuthority = join(sandboxRoot, 'authority.json');
  writeFileSync(
    sandboxAuthority,
    JSON.stringify({ id, kind: 'vault', paths, root: sandboxRoot, version: 1 }),
  );
  mkdirSync(join(sandboxRoot, 'bin'));
  const executable = join(sandboxRoot, 'bin', 'mimir');
  copyFileSync(binary, executable);
  registerInstallation({ executable, mode: 'sandbox', paths, sandboxAuthority });
  expect(JSON.parse((await run(executable)).stdout)).toEqual({
    live: false,
    paths,
    scope: { id, kind: 'sandbox' },
  });
});

test('compiled protocol candidate passes installer preflight', () => {
  const paths = {
    cache: join(root, 'protocol/cache'),
    config: join(root, 'protocol/config'),
    data: join(root, 'protocol/data'),
  };
  const receipt = installBinary({
    registration: { mode: 'live', paths },
    source: binary,
    target: join(root, 'protocol-installed'),
  });
  expect(receipt.mode).toBe('live');
});
