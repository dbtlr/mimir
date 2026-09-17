import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTransferDocument } from '../../bin/src/core/transfer-validate';
import { readInstallationAt } from '../../bin/src/installation';
import { readSandboxAuthority } from '../../bin/src/sandbox-authority';
import { Sandbox } from './workflow';

const repository = fileURLToPath(new URL('../../../', import.meta.url));

async function run(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = Bun.spawn(args, { cwd, env, stderr: 'pipe', stdin: 'ignore', stdout: 'pipe' });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stderr, stdout };
  } finally {
    clearTimeout(timer);
  }
}

test.skipIf(process.env.MIMIR_SANDBOX_LIFECYCLE_TEST !== '1')(
  'release installer registers a legacy layout and preserves its board and bindings on repeat',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mimir-legacy-install-')));
    const sandbox = new Sandbox(root);
    try {
      await symlink(join(repository, 'packages'), join(root, 'packages'));
      const id = await sandbox.create(join(repository, 'dist', 'mimir'));
      const authority = readSandboxAuthority(join(root, '.dev', 'sandboxes', id, 'authority.json'));
      const beforeExport = join(root, 'before.json');
      await sandbox.run(id, ['store', 'export', beforeExport]);
      const board = parseTransferDocument(JSON.parse(await readFile(beforeExport, 'utf8')));
      expect(board.projects).toHaveLength(2);
      expect(board.nodes).toHaveLength(4);
      const bin = join(root, 'legacy bin');
      const target = join(bin, 'mimir');
      const home = join(root, 'home');
      const temporary = join(root, 'tmp');
      const shim = join(root, 'download-shim');
      const workspace = join(root, 'workspace');
      for (const path of [bin, home, temporary, shim, workspace]) {
        await mkdir(path);
      }
      // Model an old executable without running historical code outside the receipt boundary.
      const legacy = '#!/bin/sh\ntouch "$(dirname "$0")/legacy-executed"\nexit 99\n';
      await writeFile(target, legacy, { mode: 0o755 });
      expect(readInstallationAt(target)).toBeUndefined();
      const binding = join(workspace, '.mimir.toml');
      await writeFile(binding, 'project = "MMR"\n');
      const cache = join(authority.paths.cache, 'preserved.json');
      const logs = join(authority.paths.data, 'logs');
      await mkdir(logs, { recursive: true });
      const events = join(logs, 'service-events.jsonl');
      await writeFile(cache, '{"fixture":"legacy-cache"}\n');
      await writeFile(events, '{"event":"legacy-fixture"}\n');
      const files = [join(authority.paths.config, 'config.toml'), binding, cache, events];
      const contents = await Promise.all(files.map((file) => readFile(file)));
      const candidate = join(repository, 'dist', 'mimir');
      const digest = createHash('sha256')
        .update(await readFile(candidate))
        .digest('hex');
      const sums = join(root, 'SHA256SUMS');
      const asset = `mimir-${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
      await writeFile(sums, `${digest}  ${asset}\n`);
      // Only the release download is substituted; install.sh and the compiled installer run unchanged.
      await writeFile(
        join(shim, 'curl'),
        `#!/bin/sh
set -eu
url= output=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    --proto) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  "https://github.com/dbtlr/mimir/releases/download/v0.0.0-fixture/$TEST_ASSET") cp "$TEST_DOWNLOAD" "$output" ;;
  "https://github.com/dbtlr/mimir/releases/download/v0.0.0-fixture/SHA256SUMS") cp "$TEST_SUMS" "$output" ;;
  *) echo "unexpected download: $url" >&2; exit 1 ;;
esac
`,
        { mode: 0o755 },
      );
      const env = {
        HOME: home,
        MIMIR_INSTALL_DIR: bin,
        MIMIR_VERSION: 'v0.0.0-fixture',
        NO_COLOR: '1',
        PATH: `${shim}:/usr/bin:/bin`,
        TEST_ASSET: asset,
        TEST_DOWNLOAD: candidate,
        TEST_SUMS: sums,
        TMPDIR: temporary,
        XDG_CACHE_HOME: dirname(authority.paths.cache),
        XDG_CONFIG_HOME: dirname(authority.paths.config),
        XDG_DATA_HOME: dirname(authority.paths.data),
      };
      const install = () => run(['sh', join(repository, 'install.sh')], workspace, env);
      const installed = await install();
      expect(installed.code, installed.stderr).toBe(0);
      expect(installed.stderr).toContain('checksum ok');
      const receipt = readInstallationAt(target);
      expect(receipt).toEqual({
        executable: target,
        mode: 'live',
        paths: authority.paths,
        sha256: digest,
        version: 1,
      });
      const receiptBytes = await readFile(`${target}.installation.json`, 'utf8');
      const redirected = join(root, 'redirected');
      env.XDG_CACHE_HOME = join(redirected, 'cache');
      env.XDG_CONFIG_HOME = join(redirected, 'config');
      env.XDG_DATA_HOME = join(redirected, 'data');
      for (const attempt of ['first', 'repeat']) {
        if (attempt === 'repeat') {
          const repeated = await install();
          expect(repeated.code, repeated.stderr).toBe(0);
        }
        expect(await readFile(`${target}.installation.json`, 'utf8')).toEqual(receiptBytes);
        expect(await Promise.all(files.map((file) => readFile(file)))).toEqual(contents);
        const exported = join(root, `${attempt}.json`);
        const result = await run([target, 'store', 'export', exported], workspace, env);
        expect(result.code, result.stderr).toBe(0);
        // Export time is metadata; every stored fact, including record timestamps, must survive.
        expect({
          ...parseTransferDocument(JSON.parse(await readFile(exported, 'utf8'))),
          exported_at: board.exported_at,
        }).toEqual(board);
        const listed = await run([target, 'list', '-f', 'json'], workspace, env);
        expect(listed.code, listed.stderr).toBe(0);
        expect(listed.stdout).toContain('MMR-');
        const doctor = await run([target, 'doctor', '-s', 'all', '-f', 'json'], workspace, env);
        expect(doctor.code, doctor.stderr).toBe(0);
        expect(JSON.parse(doctor.stdout)).toEqual([]);
        expect(await readdir(bin)).toEqual(['mimir', 'mimir.installation.json']);
        expect(await readdir(temporary)).toEqual([]);
        expect(await Bun.file(join(redirected, 'config', 'mimir', 'config.toml')).exists()).toBe(
          false,
        );
      }
      const incompatible = join(root, 'incompatible');
      const incompatibleBody = '#!/bin/sh\necho "candidate predates receipts"\n';
      await writeFile(incompatible, incompatibleBody, { mode: 0o755 });
      env.TEST_DOWNLOAD = incompatible;
      await writeFile(
        sums,
        `${createHash('sha256').update(incompatibleBody).digest('hex')}  ${asset}\n`,
      );
      const refused = await install();
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain(
        'candidate does not support installation protocol version 1',
      );
      expect(readInstallationAt(target)).toEqual(receipt);
      expect(await readFile(`${target}.installation.json`, 'utf8')).toEqual(receiptBytes);
      expect(await Promise.all(files.map((file) => readFile(file)))).toEqual(contents);
      expect(await readdir(bin)).toEqual(['mimir', 'mimir.installation.json']);
      expect(await readdir(temporary)).toEqual([]);
      await sandbox.verify(id);
    } finally {
      for (const id of await readdir(join(root, '.dev', 'sandboxes')).catch(() => [])) {
        await sandbox.destroy(id);
      }
      await rm(root, { force: true, recursive: true });
    }
  },
  120_000,
);
