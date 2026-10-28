import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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

/**
 * Run a build step's script in a fresh directory that `setup` fills, with
 * the directory first on PATH (so a `bun` shim there wins), then read what it left behind.
 */
async function runStep<T>(
  stepName: string,
  options: {
    env: Record<string, string>;
    setup: (directory: string) => Promise<void>;
    read: (directory: string) => Promise<T>;
  },
) {
  const workflow = workflowSchema.parse(Bun.YAML.parse(await Bun.file(workflowPath).text()));
  const script = workflow.jobs.build.steps.find((step) => step.name === stepName)?.run;
  if (script === undefined) {
    throw new Error(`missing build step ${stepName}`);
  }
  const directory = await mkdtemp(join(tmpdir(), 'mimir-release-step-'));
  try {
    await options.setup(directory);
    const child = Bun.spawn(['bash', '-euo', 'pipefail', '-c', script], {
      cwd: directory,
      env: {
        ...process.env,
        ...options.env,
        PATH: `${directory}:${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
      },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    return { exit, read: await options.read(directory), stderr };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

/**
 * Lay out a checkout's CLI package in `directory`: a package.json holding
 * `version` and the real version module, which workflow steps import for the
 * development version.
 */
async function writeCliPackage(directory: string, version: string) {
  await mkdir(join(directory, 'packages/cli/src'), { recursive: true });
  await writeFile(
    join(directory, 'packages/cli/package.json'),
    JSON.stringify({ bin: { mimir: './src/main.ts' }, name: '@mimir/cli', version }),
  );
  await writeFile(
    join(directory, 'packages/cli/src/version.ts'),
    await readFile(new URL('../src/version.ts', import.meta.url), 'utf8'),
  );
}

test('every build stamps its version into the CLI package before the build reads it', async () => {
  const workflow = workflowSchema.parse(Bun.YAML.parse(await Bun.file(workflowPath).text()));
  const { steps } = workflow.jobs.build;
  const stamp = steps.findIndex((step) => step.name === 'Stamp the build version');
  expect(stamp).toBeGreaterThanOrEqual(0);
  expect(stamp).toBeLessThan(steps.findIndex((step) => step.name === 'Compile'));
  expect(steps[stamp]?.if).toBeUndefined();
});

test.each([
  ['tag', 'v0.26.0-next.42', '0.26.0-next.42'],
  ['tag', 'v0.26.0', '0.26.0'],
  ['branch', 'feature/release', '0.26.0-next'],
])('a %s build of %s stamps %s over the released 0.25.0', async (refType, refName, expected) => {
  const result = await runStep('Stamp the build version', {
    env: { GITHUB_REF_NAME: refName, GITHUB_REF_TYPE: refType },
    read: async (directory) =>
      z
        .object({ bin: z.unknown(), name: z.string(), version: z.string() })
        .parse(await Bun.file(join(directory, 'packages/cli/package.json')).json()),
    setup: (directory) => writeCliPackage(directory, '0.25.0'),
  });
  expect(result.exit, result.stderr).toBe(0);
  expect(result.read).toEqual({
    bin: { mimir: './src/main.ts' },
    name: '@mimir/cli',
    version: expected,
  });
});

test.each([
  ['mimir-darwin-arm64', 'bun-darwin-arm64'],
  ['mimir-linux-x64', 'bun-linux-x64'],
  ['mimir-linux-arm64', 'bun-linux-arm64'],
])('%s compiles with loom build --release for %s, into dist', async (asset, target) => {
  const result = await runStep('Compile', {
    env: { ASSET: asset, GITHUB_WORKSPACE: '/work' },
    read: (directory) => readFile(join(directory, 'bun.log'), 'utf8'),
    setup: async (directory) => {
      await writeFile(join(directory, 'bun'), '#!/bin/sh\nprintf "%s\\n" "$*" >> bun.log\n', {
        mode: 0o755,
      });
    },
  });
  expect(result.exit, result.stderr).toBe(0);
  expect(result.read).toBe(
    `run --cwd packages/cli loom build --release --target ${target} --out /work/dist/${asset}\n`,
  );
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
      await writeCliPackage(directory, '0.25.0');
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

/** Run git in `cwd`, returning stdout; a failure throws with git's stderr. */
async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(['git', ...args], { cwd, stderr: 'pipe', stdout: 'pipe' });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exit !== 0) {
    throw new Error(`git ${args.join(' ')}: ${stderr}`);
  }
  return stdout;
}

/**
 * Run the prerelease tagger's script in a fresh clone of a disposable origin
 * holding `tags`, with `bun` shimmed to answer the two `loom changelog` calls
 * and `gh` shimmed to record the dispatch. Returns the tags origin holds after
 * the run and every shimmed command line.
 */
async function tag(options: {
  check: string;
  checkExit?: number;
  dryRun: string;
  released?: string;
  tags: readonly string[];
}) {
  const path = new URL('../../../.github/workflows/prerelease.yml', import.meta.url);
  const workflow = z
    .object({ jobs: z.object({ tag: jobSchema }) })
    .parse(Bun.YAML.parse(await Bun.file(path).text()));
  const script = workflow.jobs.tag.steps.find(
    (step) => step.name === 'Compute and push the prerelease tag',
  )?.run;
  if (script === undefined) {
    throw new Error('missing prerelease tagger script');
  }
  const directory = await mkdtemp(join(tmpdir(), 'mimir-prerelease-'));
  try {
    const origin = join(directory, 'origin.git');
    const checkout = join(directory, 'checkout');
    const bin = join(directory, 'bin');
    const log = join(directory, 'commands');
    await mkdir(bin);
    await writeFile(log, '');
    await git(directory, 'init', '--quiet', '--bare', origin);
    await git(directory, 'clone', '--quiet', origin, checkout);
    await mkdir(join(checkout, 'packages/cli'), { recursive: true });
    await writeFile(
      join(checkout, 'packages/cli/package.json'),
      `{\n  "name": "@mimir/cli",\n  "version": "${options.released ?? '0.25.0'}"\n}\n`,
    );
    await git(
      checkout,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'main',
    );
    for (const name of options.tags) {
      await git(checkout, 'tag', name);
    }
    await git(checkout, 'push', '--quiet', 'origin', 'HEAD:main', '--tags');
    await writeFile(
      join(bin, 'bun'),
      `#!/bin/sh
printf 'bun %s\\n' "$*" >> "$COMMAND_LOG"
case "$*" in
  'run --cwd packages/cli loom changelog check') printf '%s\\n' "$CHECK_OUTPUT"; exit "$CHECK_EXIT" ;;
  'run --cwd packages/cli loom changelog write --dry-run') printf '%s\\n' "$DRY_RUN_OUTPUT" ;;
  *) exit 99 ;;
esac
`,
      { mode: 0o755 },
    );
    await writeFile(join(bin, 'gh'), `#!/bin/sh\nprintf 'gh %s\\n' "$*" >> "$COMMAND_LOG"\n`, {
      mode: 0o755,
    });
    const child = Bun.spawn(['bash', '-euo', 'pipefail', '-c', script], {
      cwd: checkout,
      env: {
        ...process.env,
        CHECK_EXIT: String(options.checkExit ?? 0),
        CHECK_OUTPUT: options.check,
        COMMAND_LOG: log,
        DRY_RUN_OUTPUT: options.dryRun,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const pushed = (await git(origin, 'tag', '-l'))
      .split('\n')
      .filter((name) => name !== '' && !options.tags.includes(name));
    return { commands: await readFile(log, 'utf8'), exit, pushed, stderr, stdout };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

const CHECK = 'run --cwd packages/cli loom changelog check';
const DRY_RUN = 'run --cwd packages/cli loom changelog write --dry-run';

test.each([
  {
    expected: 'v0.26.0-next.11',
    next: '0.26.0',
    tags: ['v0.25.0', 'v0.25.0-next.40', 'v0.26.0-next.3', 'v0.26.0-next.10', 'v0.26.0-next.x'],
  },
  { expected: 'v0.25.1-next.1', next: '0.25.1', tags: ['v0.25.0', 'v0.25.0-next.40'] },
  {
    expected: 'v0.26.1-next.1',
    next: '0.26.1',
    released: '0.26.0',
    tags: ['v0.26.0', 'v0.26.0-next.73', 'v0.25.1-next.2'],
  },
])(
  'the tagger tags $expected from the dry run’s next version $next and dispatches its build',
  async ({ expected, next, released, tags }) => {
    const result = await tag({
      check: 'Checked 2 fragments.',
      dryRun: `## v${next} - 2026-10-28\n\n### Features\n\n- Add a thing.\n\nNext version: ${next}`,
      released,
      tags,
    });
    expect(result.exit, result.stderr).toBe(0);
    expect(result.pushed).toEqual([expected]);
    expect(result.commands).toBe(
      `bun ${CHECK}\nbun ${DRY_RUN}\ngh workflow run release.yml --ref ${expected}\n`,
    );
  },
);

test('with no pending fragments the tagger says why and tags nothing', async () => {
  const result = await tag({ check: 'Checked 0 fragments.', dryRun: '', tags: ['v0.26.0'] });
  expect(result.exit, result.stderr).toBe(0);
  expect(result.stdout).toContain('No pending changelog fragments');
  expect(result.pushed).toEqual([]);
  expect(result.commands).toBe(`bun ${CHECK}\n`);
});

test.each([
  { check: '.changes/bad.md: expected top-level change bullets.', checkExit: 1, dryRun: '' },
  { check: 'Checked 1 fragment.', dryRun: 'Next version: soon' },
  { check: 'Checked many fragments.', dryRun: 'Next version: 0.26.0' },
])('an unreadable changelog ($check) fails the tagger without a tag', async (options) => {
  const result = await tag({ ...options, tags: [] });
  expect(result.exit).not.toBe(0);
  expect(result.pushed).toEqual([]);
  expect(result.commands).not.toContain('gh ');
});

test('the tagger refuses a next version below a prerelease published since the last release', async () => {
  const result = await tag({
    check: 'Checked 1 fragment.',
    dryRun: 'Next version: 0.25.1',
    released: '0.25.0',
    tags: ['v0.25.0', 'v0.26.0-next.3'],
  });
  expect(result.exit).not.toBe(0);
  expect(result.stdout).toContain('below prerelease v0.26.0-next.3');
  expect(result.pushed).toEqual([]);
  expect(result.commands).not.toContain('gh ');
});

/** Commit everything staged in `cwd` as a throwaway author. */
function commit(cwd: string, message: string) {
  return git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', message);
}

/** Write each file under `root`, creating directories; a null content deletes it. */
async function writeFiles(root: string, files: Record<string, string | null>) {
  for (const [file, content] of Object.entries(files)) {
    if (content === null) {
      await rm(join(root, file));
    } else {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), content);
    }
  }
}

/**
 * Run the changelog guard's gate script on a PR branch that writes `head`
 * files (null deletes) over a `main` holding `base` files, with or without the
 * skip-changelog label.
 */
async function guard(options: {
  base: Record<string, string>;
  head: Record<string, string | null>;
  label?: boolean;
}) {
  const path = new URL('../../../.github/workflows/changelog-guard.yml', import.meta.url);
  const workflow = z
    .object({ jobs: z.object({ 'changelog-guard': jobSchema }) })
    .parse(Bun.YAML.parse(await Bun.file(path).text()));
  const script = workflow.jobs['changelog-guard'].steps.find((step) => step.id === 'gate')?.run;
  if (script === undefined) {
    throw new Error('missing changelog guard gate script');
  }
  const directory = await mkdtemp(join(tmpdir(), 'mimir-changelog-guard-'));
  try {
    const origin = join(directory, 'origin.git');
    const checkout = join(directory, 'checkout');
    await git(directory, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
    await git(directory, 'clone', '--quiet', origin, checkout);
    await git(checkout, 'checkout', '--quiet', '-b', 'main');
    await writeFiles(checkout, options.base);
    await git(checkout, 'add', '--all');
    await commit(checkout, 'base');
    await git(checkout, 'push', '--quiet', 'origin', 'main');
    await git(checkout, 'checkout', '--quiet', '-b', 'change');
    await writeFiles(checkout, options.head);
    await git(checkout, 'add', '--all');
    await commit(checkout, 'change');
    const child = Bun.spawn(['bash', '-euo', 'pipefail', '-c', script], {
      cwd: checkout,
      env: {
        ...process.env,
        BASE_REF: 'main',
        GITHUB_OUTPUT: join(directory, 'output'),
        HAS_SKIP_LABEL: String(options.label ?? false),
      },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const [exit, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    return { exit, stdout };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

const SNAPSHOT = 'packages/contract/engine-schemas.json';

test.each([
  ['a feature fragment', { 'packages/cli/.changes/feature.mmr-1.md': '- Add.\n' }, false],
  ['the skip-changelog label', {}, true],
])(
  'an Engine contract change with only %s fails while no breaking fragment is pending',
  async (_, fragments, label) => {
    const result = await guard({
      base: { [SNAPSHOT]: '{}\n' },
      head: { [SNAPSHOT]: '{"added":true}\n', ...fragments },
      label,
    });
    expect(result.exit).toBe(1);
    expect(result.stdout).toContain('no breaking fragment is pending');
  },
);

test('an Engine contract change passes once the cycle carries a breaking fragment', async () => {
  const result = await guard({
    base: { [SNAPSHOT]: '{}\n', 'packages/cli/.changes/breaking.mmr-1.md': '- Remove.\n' },
    head: {
      'packages/cli/.changes/feature.mmr-2.md': '- Add.\n',
      'packages/contract/src/version.ts': "export const MIN_CLIENT = '0.27.0-next';\n",
    },
  });
  expect(result.exit).toBe(0);
});

test('a build-affecting change without a fragment fails unless labeled', async () => {
  const base = { 'packages/cli/src/a.ts': '1\n' };
  const head = { 'packages/cli/src/a.ts': '2\n' };
  expect((await guard({ base, head })).exit).toBe(1);
  expect((await guard({ base, head, label: true })).exit).toBe(0);
});

test('the release cut, which only deletes fragments, passes', async () => {
  const result = await guard({
    base: { 'packages/cli/.changes/feature.mmr-1.md': '- Add.\n' },
    head: { 'packages/cli/.changes/feature.mmr-1.md': null },
  });
  expect(result.exit).toBe(0);
});
