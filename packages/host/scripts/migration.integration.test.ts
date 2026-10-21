/// <reference types="bun" />

import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { RemoteEngine } from '@mimir/wire/client';
import { z } from 'zod';

import { docker, hostCli, ready } from './docker';
import { createInstallation } from './loom-cli';
import type { Completed } from './loom-cli';

const clientVersion = z
  .object({ version: z.string() })
  .parse(await Bun.file(new URL('../../cli/package.json', import.meta.url)).json()).version;

/** The ids a `-f ids` create printed, one per line. */
function ids(run: Completed): string[] {
  expect(run.exit, run.stderr).toBe(0);
  return run.stdout.trim().split('\n');
}

/**
 * The migration guide end to end: a CLI-only install with a local board exports
 * it, imports it into a host container, pairs, and keeps working remotely. Each
 * CLI argv is the guide's; `docker exec` stands in for the guide's compose exec.
 */
test('a CLI-only install moves its board into a host and keeps working through it', async () => {
  const name = `mimir-migration-${randomUUID()}`;
  const image = `${name}:test`;
  const volume = `${name}-data`;
  const device = 'migrated laptop';
  const installation = createInstallation('[store]\nbackend = "sqlite"\n');
  const onHost = (args: string[], input?: string) => hostCli(name, args, input);
  try {
    // 1. The local board the guide starts from.
    const project = await installation.run([
      'create',
      'project',
      'Migration',
      '--key',
      'MIG',
      '--yes',
    ]);
    expect(project.exit, project.stderr).toBe(0);
    const [initiative] = ids(
      await installation.run(['create', 'initiative', 'Move in', '--parent', 'MIG', '-f', 'ids']),
    );
    const [task] = ids(
      await installation.run([
        'create',
        'task',
        'Carry the board across',
        '--parent',
        initiative ?? '',
        '-f',
        'ids',
      ]),
    );
    expect(task).toMatch(/^MIG-\d+$/);

    // 2. Export it.
    const exported = await installation.run(['store', 'export', 'board.json']);
    expect(exported.exit, exported.stderr).toBe(0);
    const board = readFileSync(join(installation.cwd, 'board.json'), 'utf8');

    // 3. A fresh host with an empty SQLite volume.
    await docker(['build', '--quiet', '--tag', image, '.'], 120_000);
    await docker(['volume', 'create', volume]);
    await docker([
      'run',
      '--detach',
      '--read-only',
      '--name',
      name,
      '--publish',
      '127.0.0.1::64647',
      '--volume',
      `${volume}:/data`,
      image,
    ]);
    const base = await ready(name);

    // 4. The preview reports what would arrive and changes nothing; --apply imports it.
    const hostNodeIds = async () =>
      z
        .object({ nodes: z.array(z.object({ id: z.string() })) })
        .parse(JSON.parse(await onHost(['store', 'export', '-'])))
        .nodes.map((node) => node.id);
    expect(JSON.parse(await onHost(['store', 'import', '-'], board))).toEqual({
      applied: false,
      created: 3,
      mode: 'fresh',
      skipped: 0,
    });
    expect(await hostNodeIds()).toEqual([]);
    expect(JSON.parse(await onHost(['store', 'import', '-', '--apply'], board))).toMatchObject({
      applied: true,
      created: 3,
    });
    expect(await hostNodeIds()).toEqual(expect.arrayContaining([initiative, task]));

    // 5. Pairing refuses while the install still owns a local board, before it
    // files a request the operator would have to approve for nothing.
    const config = readFileSync(installation.configFile, 'utf8');
    const refused = await installation.run([
      'pair',
      base,
      '--device',
      device,
      '--no-input',
      '-f',
      'json',
    ]);
    expect(refused.exit).toBe(1);
    expect(refused.stderr).toContain(`${installation.configFile} declares [store]`);
    expect(refused.stderr).toContain('mimir store export board.json');
    expect(JSON.parse(await onHost(['pending', '-f', 'json']))).toEqual([]);
    expect(readFileSync(installation.configFile, 'utf8')).toBe(config);
    expect(await Bun.file(installation.credentialsFile).exists()).toBe(false);

    // 6. Remove [store], as the guide says.
    writeFileSync(installation.configFile, '');

    // 7. Pair, approving the code the CLI prints on the host. The old store
    // still holds the exported board, so pairing is told to leave it behind.
    const pairing = installation.spawn([
      'pair',
      base,
      '--device',
      device,
      '--leave-local-board',
      '--no-input',
      '-f',
      'json',
    ]);
    const [, code] = await pairing.stderrMatch(/pairing code ([0-9A-Z]{4}-[0-9A-Z]{4})/);
    await onHost(['approve', code ?? '']);
    const paired = await pairing.completed();
    expect(paired.exit, paired.stderr).toBe(0);
    expect(JSON.parse(paired.stdout)).toMatchObject({ device, origin: base });

    // 8. A clean remote setup has nothing for doctor to say.
    const doctor = await installation.run(['doctor', '-f', 'json']);
    expect(doctor.exit, doctor.stderr).toBe(0);
    expect(JSON.parse(doctor.stdout)).toEqual([]);

    // 9. The imported work reads and completes through the host.
    const read = await installation.run(['get', task ?? '', '-f', 'json']);
    expect(read.exit, read.stderr).toBe(0);
    expect(JSON.parse(read.stdout)).toMatchObject({ title: 'Carry the board across' });
    const done = await installation.run(['done', task ?? '']);
    expect(done.exit, done.stderr).toBe(0);

    // 10. The host agrees, under the one token the pairing issued.
    expect(JSON.parse(await onHost(['tokens', '-f', 'json']))).toEqual([
      expect.objectContaining({ device, revoked_at: null }),
    ]);
    const { token } = z
      .object({ token: z.string() })
      .parse(Bun.TOML.parse(readFileSync(installation.credentialsFile, 'utf8')));
    const remote = new RemoteEngine({
      headers: { authorization: `Bearer ${token}` },
      url: `${base}/trpc`,
      version: clientVersion,
    });
    expect(await remote.getNode({ id: task ?? '' })).toMatchObject({ lifecycle: 'done' });
  } finally {
    installation.dispose();
    await docker(['rm', '--force', name]).catch(() => undefined);
    await docker(['volume', 'rm', volume]).catch(() => undefined);
    await docker(['image', 'rm', '--force', image]).catch(() => undefined);
  }
}, 240_000);
