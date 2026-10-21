import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

const workflowPath = new URL('../../../.github/workflows/release.yml', import.meta.url);
const executionSchema = z.object({
  'continue-on-error': z.union([z.boolean(), z.string()]).optional(),
  if: z.string().optional(),
});
const stepSchema = executionSchema.extend({
  env: z.record(z.string(), z.string()).optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  run: z.string().optional(),
  uses: z.string().optional(),
});
const jobSchema = executionSchema.extend({ steps: z.array(stepSchema) });
const workflowSchema = z.object({
  jobs: z.object({
    build: jobSchema.extend({
      strategy: z.object({
        matrix: z.object({ include: z.array(z.object({ asset: z.string(), os: z.string() })) }),
      }),
    }),
    'host-image': z.object({
      needs: z.union([z.string(), z.array(z.string())]).optional(),
      steps: z.array(stepSchema),
    }),
  }),
  on: z.object({ pull_request: z.object({ paths: z.array(z.string()) }) }),
});

test('every pull request retains the full Linux suite, including stacked branches', async () => {
  const path = new URL('../../../.github/workflows/ci.yml', import.meta.url);
  const workflow = z
    .object({
      jobs: z.object({ gate: jobSchema }),
      on: z.object({ pull_request: z.unknown() }),
    })
    .parse(Bun.YAML.parse(await Bun.file(path).text()));
  expect(workflow.on.pull_request).toBeNull();
  expect(workflow.jobs.gate.if).toBeUndefined();
  expect(workflow.jobs.gate['continue-on-error']).toBeUndefined();
  const step = workflow.jobs.gate.steps.find((candidate) => candidate.run === 'bun run test');
  expect(step).toBeDefined();
  expect(step?.if).toBeUndefined();
  expect(step?.['continue-on-error']).toBeUndefined();
});

test('pull requests validate every native release target, including Bun upgrades', async () => {
  const workflow = workflowSchema.parse(Bun.YAML.parse(await Bun.file(workflowPath).text()));
  const { build } = workflow.jobs;
  expect(build.if).toBeUndefined();
  expect(build['continue-on-error']).toBeUndefined();
  expect(build.strategy.matrix.include).toHaveLength(3);
  expect(build.strategy.matrix.include).toEqual(
    expect.arrayContaining([
      { asset: 'mimir-darwin-arm64', os: 'macos-latest' },
      { asset: 'mimir-linux-x64', os: 'ubuntu-latest' },
      { asset: 'mimir-linux-arm64', os: 'ubuntu-24.04-arm' },
    ]),
  );
  expect(workflow.on.pull_request.paths).toContain('.tool-versions');
});

test.each([
  { code: 0, event: 'pull_request', suite: 'test:native' },
  { code: 0, event: 'push', suite: 'test' },
  { code: 0, event: 'workflow_dispatch', suite: 'test' },
  { code: 17, event: 'pull_request', suite: 'test:native' },
  { code: 17, event: 'push', suite: 'test' },
])('$event selects $suite and propagates exit $code', async ({ code, event, suite }) => {
  const workflow = workflowSchema.parse(Bun.YAML.parse(await Bun.file(workflowPath).text()));
  const step = workflow.jobs.build.steps.find((candidate) => candidate.id === 'tests');
  expect(step?.if).toBeUndefined();
  expect(step?.['continue-on-error']).toBeUndefined();
  const script = step?.run;
  if (script === undefined) {
    throw new Error('missing source test selection script');
  }
  const directory = await mkdtemp(join(tmpdir(), 'mimir-release-tests-'));
  try {
    await writeFile(
      join(directory, 'bun'),
      '#!/bin/sh\nprintf "%s\\n" "$*"\nexit "$MIMIR_TEST_EXIT"\n',
      { mode: 0o755 },
    );
    const child = Bun.spawn(['bash', '-euo', 'pipefail', '-c', script], {
      cwd: directory,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: event,
        MIMIR_TEST_EXIT: String(code),
        PATH: `${directory}:${process.env.PATH ?? ''}`,
      },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit, stderr).toBe(code);
    expect(stdout).toBe(`run ${suite}\n`);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('the compiled release artifact passes CLI and MCP checks before upload', async () => {
  const workflow = workflowSchema.parse(Bun.YAML.parse(await Bun.file(workflowPath).text()));
  const { steps } = workflow.jobs.build;
  const compile = steps.findIndex((step) => step.name === 'Compile');
  const smoke = steps.findIndex((step) => step.id === 'native-smoke');
  const upload = steps.findIndex((step) => step.uses === 'actions/upload-artifact@v7');
  expect(compile).toBeGreaterThanOrEqual(0);
  expect(smoke).toBeGreaterThan(compile);
  expect(upload).toBeGreaterThan(smoke);
  expect(steps[smoke]?.if).toBeUndefined();
  expect(steps[smoke]?.['continue-on-error']).toBeUndefined();
  expect(steps[smoke]?.env).toMatchObject({
    MIMIR_SANDBOX_LIFECYCLE_TEST: '1',
    MIMIR_TEST_BINARY: `\${{ github.workspace }}/dist/\${{ matrix.asset }}`,
  });
  expect(steps[smoke]?.run).toBe('bun test packages/sandbox/src/mcp-binding.integration.test.ts');
});

test('binary test or build failure prevents image publication', async () => {
  const workflow = workflowSchema.parse(Bun.YAML.parse(await Bun.file(workflowPath).text()));
  expect(workflow.jobs['host-image'].needs).toContain('build');
});

/** Exercise the workflow script against a disposable Docker CLI boundary. */
async function promote(version: string, currentVersion: string, inspectError = '') {
  const workflow = workflowSchema.parse(Bun.YAML.parse(await Bun.file(workflowPath).text()));
  const script = workflow.jobs['host-image'].steps.find((step) => step.id === 'promote')?.run;
  if (script === undefined) {
    throw new Error('missing channel promotion script');
  }
  const directory = await mkdtemp(join(tmpdir(), 'mimir-image-channel-'));
  const log = join(directory, 'commands');
  try {
    await writeFile(log, '');
    await writeFile(
      join(directory, 'docker'),
      `#!/bin/sh
if [ "$3" = create ]; then
  printf '%s\\n' "$@" >> "$COMMAND_LOG"
elif [ "$3" = inspect ]; then
  case "$*" in
    *--format*) printf '%s\\n' "$IMAGE_DIGEST" ;;
    *)
      if [ -n "$INSPECT_ERROR" ]; then
        printf '%s\\n' "$INSPECT_ERROR" >&2
        exit 1
      elif [ -z "$CURRENT_VERSION" ]; then
        printf '%s: not found\\n' "$4" >&2
        exit 1
      fi
      printf '{"annotations":{"org.opencontainers.image.version":"%s"}}' "$CURRENT_VERSION"
      ;;
  esac
else
  exit 99
fi
`,
      { mode: 0o755 },
    );
    const child = Bun.spawn(['bash', '-euo', 'pipefail', '-c', script], {
      cwd: directory,
      env: {
        ...process.env,
        COMMAND_LOG: log,
        CURRENT_VERSION: currentVersion,
        IMAGE_CHANNEL: version.includes('-') ? 'next' : 'latest',
        IMAGE_DIGEST: 'sha256:fixture',
        IMAGE_VERSION: version,
        INSPECT_ERROR: inspectError,
        PATH: `${directory}:${process.env.PATH ?? ''}`,
      },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { commands: await readFile(log, 'utf8'), exit, stderr, stdout };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test('a delayed prerelease cannot replace a newer next image', async () => {
  const result = await promote('0.26.0-next.41', '0.26.0-next.42');
  expect(result.exit, result.stderr).toBe(0);
  expect(result.commands).toBe('');
});

test('an older hotfix cannot replace a newer latest image', async () => {
  const result = await promote('0.25.1', '0.26.0');
  expect(result.exit, result.stderr).toBe(0);
  expect(result.commands).toBe('');
});

test.each([
  ['0.26.0-next.10', '0.26.0-next.2', 'next'],
  ['0.26.0-next.10', '0.26.0-next.10', 'next'],
  ['0.26.0', '', 'latest'],
  ['0.26.0', '0.25.1', 'latest'],
])('version %s can advance or retry channel %s', async (version, currentVersion, channel) => {
  const result = await promote(version, currentVersion);
  expect(result.exit, result.stderr).toBe(0);
  expect(result.commands).toBe(
    `buildx\nimagetools\ncreate\n--tag\nghcr.io/dbtlr/mimir-host:${channel}\nghcr.io/dbtlr/mimir-host@sha256:fixture\n`,
  );
});

test('a registry failure cannot be mistaken for a missing channel', async () => {
  const result = await promote('0.26.0', '', 'unexpected status: 503 Service Unavailable');
  expect(result.exit).not.toBe(0);
  expect(result.commands).toBe('');
});

test('an invalid current version refuses channel promotion', async () => {
  const result = await promote('0.26.0', 'invalid');
  expect(result.exit).not.toBe(0);
  expect(result.commands).toBe('');
});

test.each([
  ['branch', 'feature/image', '0.26.0-next', ''],
  ['tag', 'v0.26.0-next.42', '0.26.0-next.42', 'next'],
  ['tag', 'v0.26.0', '0.26.0', 'latest'],
])(
  'image metadata for %s %s matches the binary version and release channel',
  async (refType, refName, version, channel) => {
    const workflow = workflowSchema.parse(Bun.YAML.parse(await Bun.file(workflowPath).text()));
    const script = workflow.jobs['host-image'].steps.find((step) => step.id === 'metadata')?.run;
    expect(script).toBeDefined();
    if (script === undefined) {
      throw new Error('missing image metadata script');
    }
    const directory = await mkdtemp(join(tmpdir(), 'mimir-image-metadata-'));
    const output = join(directory, 'output');
    try {
      await mkdir(join(directory, 'packages/bin'), { recursive: true });
      await writeFile(join(directory, 'packages/bin/package.json'), '{"version":"0.26.0-next"}');
      const child = Bun.spawn(['bash', '-euo', 'pipefail', '-c', script], {
        cwd: directory,
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          GITHUB_REF_NAME: refName,
          GITHUB_REF_TYPE: refType,
        },
        stderr: 'pipe',
        stdout: 'pipe',
      });
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited, stderr).toBe(0);
      expect(await readFile(output, 'utf8')).toBe(`version=${version}\nchannel=${channel}\n`);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  },
);
