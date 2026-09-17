import { fileURLToPath } from 'node:url';

import { Application, Command } from '@loomcli/core';
import { help } from '@loomcli/plugins/help';
import { z } from 'zod';

import { snapshotSchema } from './snapshot';
import { Sandbox } from './workflow';

if (Bun.version !== '1.4.0') {
  throw new Error(
    'Sandbox tooling requires Bun 1.4.0. Run mise install and use the workspace runtime.',
  );
}

const sandbox = new Sandbox(
  fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, ''),
);
const application = new Application('sandbox', {
  description: 'Reproducible disposable Mimir installations.',
  plugins: [help()],
})
  .command(
    new Command('snapshot-schema', {
      description: 'Print the portable snapshot manifest JSON Schema.',
    }).action(async ({ out }) => {
      await out.print(JSON.stringify(z.toJSONSchema(snapshotSchema), null, 2));
    }),
  )
  .command(
    new Command('create', { description: 'Create, migrate, seed, and verify disposable Postgres.' })
      .option('binary', {
        description: 'Existing compiled binary; otherwise build the checkout.',
        type: 'string',
      })
      .action(async ({ options, out }) => {
        await out.print(await sandbox.create(options.binary));
      }),
  )
  .command(
    new Command('restore', {
      description: 'Restore a snapshot into a fresh database without migrating.',
    })
      .argument('snapshot', {
        description: 'Snapshot ID or latest from configured directory.',
        required: true,
      })
      .action(async ({ args, out }) => {
        await out.print(await sandbox.restore(args.snapshot));
      }),
  )
  .command(
    new Command('verify', { description: 'Verify sandbox store integrity.' })
      .argument('id', { required: true })
      .action(async ({ args }) => {
        await sandbox.verify(args.id);
      }),
  )
  .command(
    new Command('upgrade', { description: 'Install a candidate and run its real migrations.' })
      .argument('id', { required: true })
      .option('to', { description: 'Candidate binary path.', required: true, type: 'string' })
      .action(async ({ args, options }) => {
        await sandbox.upgrade(args.id, options.to);
      }),
  )
  .command(
    new Command('rehearse', {
      description: 'Restore, upgrade, verify, and clean up; retain failures.',
    })
      .argument('snapshot', { required: true })
      .option('to', { description: 'Candidate binary path.', required: true, type: 'string' })
      .action(async ({ args, options, out }) => {
        await out.print(await sandbox.rehearse(args.snapshot, options.to));
      }),
  )
  .command(
    new Command('run', {
      description:
        'Run finite candidate CLI commands with isolated configuration. Output is captured; timeout is ten minutes. Append -- then Mimir arguments.',
    })
      .argument('id', { required: true })
      .action(async ({ args, passthrough, out }) => {
        await out.print(await sandbox.run(args.id, passthrough));
      }),
  )
  .command(
    new Command('destroy', { description: 'Remove only resources owned by a sandbox.' })
      .argument('id', { required: true })
      .action(async ({ args }) => {
        await sandbox.destroy(args.id);
      }),
  )
  .command(
    new Command('test', {
      description: 'Run repository tests against disposable Postgres.',
    }).action(async () => {
      await sandbox.test();
    }),
  );

await application.run();
