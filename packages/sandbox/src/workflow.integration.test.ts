import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  appendFile,
  copyFile,
  rename,
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
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerInstallation } from '../../bin/src/installation';
import { readSandboxAuthority } from '../../bin/src/sandbox-authority';
import { Sandbox } from './workflow';

const repository = fileURLToPath(new URL('../../../', import.meta.url));

test.skipIf(process.env.MIMIR_SANDBOX_LIFECYCLE_TEST !== '1')(
  'a fixture installation can be archived, restored, upgraded, verified and removed',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mimir-lifecycle-')));
    const sandbox = new Sandbox(root);
    let fixture: string | undefined;
    try {
      await symlink(join(repository, 'packages'), join(root, 'packages'));
      fixture = await sandbox.create(join(repository, 'dist', 'mimir'));
      const authority = readSandboxAuthority(
        join(root, '.dev', 'sandboxes', fixture, 'authority.json'),
      );
      expect(
        JSON.parse(await sandbox.run(fixture, ['doctor', '-s', 'all', '--format', 'json'])),
      ).toEqual([]);
      const snapshot = join(root, 'snapshots', 'fixture-v1');
      await mkdir(snapshot, { recursive: true });
      const archive = join(snapshot, 'database.dump');
      const dump = Bun.spawn(
        [
          'docker',
          'exec',
          authority.containerId,
          'pg_dump',
          '--format=custom',
          '--username=mimir_sandbox',
          '--dbname=mimir_sandbox',
        ],
        { stderr: 'pipe', stdout: Bun.file(archive) },
      );
      const error = await new Response(dump.stderr).text();
      expect(await dump.exited, error).toBe(0);
      const sha256 = createHash('sha256')
        .update(await readFile(archive))
        .digest('hex');
      await writeFile(
        join(snapshot, 'snapshot.json'),
        JSON.stringify({
          capturedAt: new Date().toISOString(),
          id: 'fixture-v1',
          pgDumpVersion: '18.6',
          postgresVersion: '18.6',
          sha256,
          version: 1,
        }),
      );
      await writeFile(
        join(root, '.dev', 'sandbox.json'),
        JSON.stringify({ snapshots: { directory: 'snapshots' } }),
      );
      const report = JSON.parse(
        await readFile(await sandbox.rehearse('latest', join(repository, 'dist', 'mimir')), 'utf8'),
      );
      expect(report.snapshot.sha256).toBe(sha256);
      expect(report.snapshot.id).toBe('fixture-v1');
      expect(report.verification.doctor).toEqual([]);
      expect(report.verification.exported).toBe(true);
      expect(await readdir(join(root, '.dev', 'sandboxes'))).toEqual([fixture]);
      const wrong = join(root, 'snapshots', 'wrong-database');
      await mkdir(wrong);
      const wrongArchive = join(wrong, 'database.dump');
      const wrongDump = Bun.spawn(
        [
          'docker',
          'exec',
          authority.containerId,
          'pg_dump',
          '--format=custom',
          '--username=mimir_sandbox',
          '--dbname=template1',
        ],
        { stderr: 'pipe', stdout: Bun.file(wrongArchive) },
      );
      expect(await wrongDump.exited, await new Response(wrongDump.stderr).text()).toBe(0);
      await writeFile(
        join(wrong, 'snapshot.json'),
        JSON.stringify({
          capturedAt: new Date().toISOString(),
          id: 'wrong-database',
          pgDumpVersion: '18.6',
          postgresVersion: '18.6',
          sha256: createHash('sha256')
            .update(await readFile(wrongArchive))
            .digest('hex'),
          version: 1,
        }),
      );
      const wrongError: unknown = await sandbox
        .restore('wrong-database')
        .catch((reason: unknown) => reason);
      expect(String(wrongError)).toContain('schema_version');
      const failed = (await readdir(join(root, '.dev', 'sandboxes'))).find((id) => id !== fixture);
      expect(failed).toBeDefined();
      if (!failed) {
        throw new Error('Expected retained failed restore');
      }
      expect(
        JSON.parse(await readFile(join(root, '.dev', 'sandboxes', failed, 'run.json'), 'utf8'))
          .status,
      ).toBe('failed');
      expect(await Bun.file(join(root, '.dev', 'sandboxes', failed, 'bin', 'mimir')).exists()).toBe(
        false,
      );
      await sandbox.destroy(failed);
      const outside = join(root, 'synthetic-live');
      await mkdir(outside);
      const liveBinary = join(outside, 'mimir');
      await copyFile(join(repository, 'dist', 'mimir'), liveBinary);
      registerInstallation({
        executable: liveBinary,
        mode: 'live',
        paths: {
          cache: join(outside, 'cache'),
          config: join(outside, 'config'),
          data: join(outside, 'data'),
        },
      });
      const liveBefore = await readFile(liveBinary);
      const liveReceipt = await readFile(`${liveBinary}.installation.json`, 'utf8');
      const sandboxBinary = join(authority.root, 'bin', 'mimir');
      await rename(sandboxBinary, `${sandboxBinary}.saved`);
      await symlink(liveBinary, sandboxBinary);
      const symlinkError: unknown = await sandbox
        .upgrade(fixture, join(repository, 'dist', 'mimir'))
        .catch((reason: unknown) => reason);
      expect(String(symlinkError)).toContain('symlink');
      expect(await readFile(liveBinary)).toEqual(liveBefore);
      expect(await readFile(`${liveBinary}.installation.json`, 'utf8')).toBe(liveReceipt);
      await rm(sandboxBinary);
      await rename(`${sandboxBinary}.saved`, sandboxBinary);
      await sandbox.verify(fixture);
      await appendFile(sandboxBinary, 'tampered');
      const verifyError: unknown = await sandbox.verify(fixture).catch((reason: unknown) => reason);
      expect(verifyError).toBeInstanceOf(Error);
      expect(JSON.parse(await readFile(join(authority.root, 'run.json'), 'utf8')).status).toBe(
        'failed',
      );
      expect(await Bun.file(join(authority.root, 'verification.json')).exists()).toBe(false);
      expect((await readdir(join(authority.root, 'events'))).length).toBeGreaterThan(3);
      const runFile = join(authority.root, 'run.json');
      const originalRun = await readFile(runFile, 'utf8');
      await writeFile(
        runFile,
        JSON.stringify({ ...JSON.parse(originalRun), dockerId: 'another-daemon' }),
      );
      const daemonError: unknown = await sandbox
        .destroy(fixture)
        .catch((reason: unknown) => reason);
      expect(String(daemonError)).toContain('Docker daemon changed');
      expect(await Bun.file(runFile).exists()).toBe(true);
      await writeFile(runFile, originalRun);
      const renamed = Bun.spawn(
        ['docker', 'rename', authority.containerId, `mimir-renamed-${fixture}`],
        { stderr: 'pipe', stdout: 'ignore' },
      );
      expect(await renamed.exited, await new Response(renamed.stderr).text()).toBe(0);
      await sandbox.destroy(fixture);
      const missing = Bun.spawn(['docker', 'inspect', authority.containerId], {
        stderr: 'ignore',
        stdout: 'ignore',
      });
      expect(await missing.exited).not.toBe(0);
      fixture = undefined;
      expect(await readdir(join(root, '.dev', 'sandboxes'))).toEqual([]);
    } finally {
      for (const id of await readdir(join(root, '.dev', 'sandboxes')).catch(() => [])) {
        await sandbox.destroy(id);
      }
      await rm(root, { force: true, recursive: true });
    }
  },
  120_000,
);
