import { fileURLToPath } from 'node:url';

import { Application, Command } from '@loomcli/core';
import { help } from '@loomcli/plugins/help';
import { z } from 'zod';

import { SERVICE_VERIFY_TARGETS, ServiceVerifier } from './service-verify';
import { HARNESSES, SkillEval } from './skill-eval';
import { snapshotSchema } from './snapshot';
import { Sandbox } from './workflow';

if (Bun.version !== '1.4.0') {
  throw new Error(
    'Sandbox tooling requires Bun 1.4.0. Run mise install and use the workspace runtime.',
  );
}

/** A comma-separated option as its non-empty entries. */
const list = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');

/** A positive-integer option, or `fallback` when absent. */
function count(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

const repository = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const sandbox = new Sandbox(repository);
const services = new ServiceVerifier(repository);
const evals = new SkillEval(repository);
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
    new Command('service-verify', {
      description:
        'Verify the real supervisor lifecycle (install, status, restart, kill-and-recover, stop, start, uninstall) without touching live units. host: a sandbox installation under launchd (macOS) or systemd (Linux). container: systemd in a disposable container, installed through install.sh.',
    })
      .option('target', {
        description: 'host (default) or container.',
        type: 'string',
      })
      .option('binary', {
        description:
          'Existing compiled binary (a Linux binary for container); otherwise build the checkout.',
        type: 'string',
      })
      .action(async ({ options, out }) => {
        const target = SERVICE_VERIFY_TARGETS.find((t) => t === (options.target ?? 'host'));
        if (target === undefined) {
          throw new Error(`--target must be one of: ${SERVICE_VERIFY_TARGETS.join(', ')}`);
        }
        await out.print(await services.verify(target, options.binary));
      }),
  )
  .command(
    new Command('service-destroy', {
      description: 'Tear down a retained service-verify sandbox by ownership.',
    })
      .argument('id', { required: true })
      .action(async ({ args }) => {
        await services.destroy(args.id);
      }),
  )
  .command(
    new Command('skill-eval', {
      description:
        'Run the agent skill through behavior scenarios with real Claude and Codex agents, each in its own vault sandbox, and report pass rates. Agents vary run to run: compare skill revisions on the same scenarios, models, and --repeat.',
    })
      .option('skill', {
        description: 'Skill directory under test (default skills/mimir).',
        type: 'string',
      })
      .option('harness', {
        description: 'claude, codex, or both comma-separated (default both).',
        type: 'string',
      })
      .option('claude-model', {
        description: 'Claude model (default: the harness default).',
        type: 'string',
      })
      .option('codex-model', {
        description: 'Codex model (default: the harness default).',
        type: 'string',
      })
      .option('scenario', {
        description: 'Comma-separated scenario names (default all).',
        type: 'string',
      })
      .option('repeat', {
        description: 'Runs per scenario and harness (default 1).',
        type: 'string',
      })
      .option('concurrency', { description: 'Runs in flight at once (default 4).', type: 'string' })
      .option('binary', {
        description: 'Existing compiled binary; otherwise build the checkout.',
        type: 'string',
      })
      .option('keep', { description: 'Keep passing runs’ sandboxes too.', type: 'boolean' })
      .action(async ({ options, out }) => {
        const harnesses = list(options.harness);
        const chosen =
          harnesses.length === 0 ? HARNESSES : HARNESSES.filter((h) => harnesses.includes(h));
        if (chosen.length !== Math.max(harnesses.length, chosen.length) || chosen.length === 0) {
          throw new Error(`--harness must name ${HARNESSES.join(' and/or ')}`);
        }
        await out.print(
          await evals.run({
            binary: options.binary,
            concurrency: count(options.concurrency, 4, 'concurrency'),
            harnesses: chosen,
            keep: options.keep,
            models: { claude: options['claude-model'], codex: options['codex-model'] },
            repeat: count(options.repeat, 1, 'repeat'),
            scenarios: list(options.scenario),
            skill: options.skill ?? 'skills/mimir',
          }),
        );
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
