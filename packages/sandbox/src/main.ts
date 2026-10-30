import { fileURLToPath } from 'node:url';

import { Application, Command } from '@loomcli/core';
import { help } from '@loomcli/plugins/help';

import { SandboxUsageError } from './failures';
import { hostPort } from './host';
import { HARNESSES, SkillEval } from './skill-eval';
import { Sandbox } from './workflow';

if (Bun.version !== '1.4.4') {
  process.stderr.write(
    'Sandbox tooling requires Bun 1.4.4. Run mise install and use the workspace runtime.\n',
  );
  process.exit(1);
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
    throw new SandboxUsageError(`--${name} must be a positive integer`);
  }
  return parsed;
}

const repository = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const sandbox = new Sandbox(repository);
const evals = new SkillEval(repository);
export const application = new Application('sandbox', {
  description: 'Reproducible disposable Mimir installations.',
  plugins: [help()],
})
  .command(
    new Command('create', {
      description: 'Create a disposable Postgres sandbox for the development host.',
    }).action(async ({ out }) => {
      await out.print(await sandbox.create());
    }),
  )
  .command(
    new Command('host', {
      description:
        'Run the development host against an owned sandbox, bound to loopback. Stops after twelve hours; interruption leaves the sandbox available.',
    })
      .argument('id', { description: 'Sandbox ID.', required: true })
      .option('port', { description: `Listening port (default ${hostPort()}).`, type: 'string' })
      .action(async ({ args, options }) => {
        await sandbox.host(args.id, options.port);
      }),
  )
  .command(
    new Command('destroy', { description: 'Remove only resources owned by a sandbox.' })
      .argument('id', { description: 'Sandbox ID.', required: true })
      .action(async ({ args }) => {
        await sandbox.destroy(args.id);
      }),
  )
  .command(
    new Command('skill-eval', {
      description:
        'Run the agent skill through behavior scenarios with real Claude and Codex agents, each in its own local sandbox, and report pass rates. Agents vary run to run: compare skill revisions on the same scenarios, models, and --repeat.',
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
          throw new SandboxUsageError(`--harness must name ${HARNESSES.join(' and/or ')}`);
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

if (import.meta.main) {
  await application.run();
}
