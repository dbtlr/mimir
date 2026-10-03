/**
 * Hold an agent skill to the behavior scenarios: run each scenario under each
 * harness in its own local sandbox, grade the outcome, and report pass rates.
 * The agents are real, so results vary run to run — compare skill revisions on
 * the same scenarios, models, and repeat count, never on a single run.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { capture, command, hashFile, InterruptedError, privateJson } from './process';
import {
  assertSandboxResolution,
  createEvalSandbox,
  exportStore,
  installSkill,
  settleCodexLogin,
} from './skill-eval-sandbox';
import type { EvalSandbox, Harness } from './skill-eval-sandbox';
import { SCENARIOS, UNIVERSAL_CHECKS } from './skill-eval-scenarios';
import type { Scenario } from './skill-eval-scenarios';
import {
  binaryPaths,
  mimirCalls,
  relativeCalls,
  parseClaudeStream,
  parseCodexStream,
} from './skill-eval-transcript';

export const HARNESSES: readonly Harness[] = ['claude', 'codex'];

export type EvalOptions = {
  skill: string;
  harnesses: readonly Harness[];
  /** Per-harness model; absent uses the harness default. */
  models: Partial<Record<Harness, string>>;
  repeat: number;
  /** Scenario names; empty runs them all. */
  scenarios: readonly string[];
  binary?: string;
  concurrency: number;
  /** Keep every run's sandbox, not only failed ones. */
  keep: boolean;
};

type CheckResult = { name: string; passed: boolean; error?: string };

export type RunResult = {
  scenario: string;
  harness: Harness;
  model: string;
  attempt: number;
  passed: boolean;
  checks: CheckResult[];
  durationMs: number;
  exit: number;
  mimirCalls: string[];
  finalText: string;
  /** Skills the agent loaded, where the harness reports it (Claude). */
  skills: string[];
  /** Why the run could not be graded (a failed setup); absent when it ran. */
  error?: string;
  root: string;
};

/** One agent turn per run; long enough for a careful agent, short enough to bound a stall. */
const AGENT_TIMEOUT_MS = 15 * 60_000;

/** A content digest of the skill directory, so a report names exactly what it measured. */
export function skillDigest(skill: string): string {
  const hash = createHash('sha256');
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).toSorted()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else {
        hash.update(relative(skill, path)).update('\0').update(readFileSync(path)).update('\0');
      }
    }
  };
  walk(skill);
  return hash.digest('hex');
}

function agentCommand(harness: Harness, prompt: string, model: string | undefined, root: string) {
  if (harness === 'claude') {
    return [
      Bun.which('claude') ?? 'claude',
      '-p',
      prompt,
      // Project settings only: the run sees the skill under test, never the
      // operator's user-level skills, CLAUDE.md, or hooks.
      '--setting-sources',
      'project',
      '--permission-mode',
      'bypassPermissions',
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
      ...(model === undefined ? [] : ['--model', model]),
    ];
  }
  return [
    Bun.which('codex') ?? 'codex',
    'exec',
    '--json',
    '--ephemeral',
    '--sandbox',
    'workspace-write',
    // The sandbox's store lives beside the working copy, not inside it.
    '--add-dir',
    root,
    ...(model === undefined ? [] : ['--model', model]),
    prompt,
  ];
}

/** A run that could reach a mimir other than its sandbox's: the whole evaluation stops. */
export class SafetyError extends Error {
  override name = 'SafetyError';
}

/**
 * What a transcript could have reached besides the sandbox binary: named or
 * PATH-added `mimir` executables that are not the sandbox's, and any call
 * through a relative path, whose target cannot be known afterwards.
 */
export function escapes(commands: readonly string[], sandboxBinary: string): string[] {
  const sandbox = realpathSync(sandboxBinary);
  const named = binaryPaths(commands).filter((path) => {
    const absolute = path.startsWith('~') ? join(homedir(), path.slice(1)) : path;
    const stat = statSync(absolute, { throwIfNoEntry: false });
    return stat?.isFile() === true && realpathSync(absolute) !== sandbox;
  });
  return [...named, ...relativeCalls(commands).map((c) => `relative call: ${c.slice(0, 120)}`)];
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Check `mimir` resolution in Claude's real tool shell, once per evaluation and
 * before any scenario. The pre-run shell checks approximate that shell; this
 * asks a cheap Claude session to record `type mimir` into a file, from the same
 * environment and flags every run uses, and refuses unless it names the sandbox.
 */
async function verifyClaudeShell(root: string, binary: string): Promise<void> {
  const sandbox = await createEvalSandbox({ binary, files: {}, harness: 'claude', root });
  const prompt =
    'Run exactly this shell command, once, and nothing else: type mimir > .shell-canary';
  await capture(agentCommand('claude', prompt, 'haiku', sandbox.root), {
    cwd: sandbox.work,
    env: sandbox.env,
    group: true,
    timeout: 5 * 60_000,
  });
  const recorded = await readFile(join(sandbox.work, '.shell-canary'), 'utf8').catch(() => '');
  if (recorded.trim() !== `mimir is ${sandbox.binary}`) {
    throw new SafetyError(
      `Claude's tool shell resolves mimir as "${recorded.trim() || 'nothing recorded'}", not the sandbox binary; refusing to run`,
    );
  }
  await rm(root, { force: true, recursive: true });
}

type Run = { scenario: Scenario; harness: Harness; attempt: number };

async function runOne(
  evalRoot: string,
  binary: string,
  options: EvalOptions,
  { scenario, harness, attempt }: Run,
  signal: AbortSignal,
): Promise<RunResult> {
  const model = options.models[harness];
  const root = join(evalRoot, `${scenario.name}-${harness}-${String(attempt)}`);
  const outcome = (fields: Partial<RunResult>): RunResult => ({
    attempt,
    checks: [],
    durationMs: 0,
    exit: -1,
    finalText: '',
    harness,
    mimirCalls: [],
    model: model ?? 'default',
    passed: false,
    root,
    scenario: scenario.name,
    skills: [],
    ...fields,
  });

  const sandbox = await createEvalSandbox({ binary, files: scenario.files, harness, root });
  let ids: Record<string, string>;
  let before: unknown;
  try {
    ids = await scenario.setup(sandbox.mimir);
    if (scenario.bind !== undefined) {
      await sandbox.mimir(['bind', scenario.bind]);
    }
    await installSkill(sandbox, options.skill, harness);
    before = await exportStore(sandbox, 'store-before');
  } catch (error) {
    if (error instanceof InterruptedError) {
      throw error;
    }
    return outcome({ error: `setup failed: ${message(error)}` });
  }
  try {
    await assertSandboxResolution(sandbox, harness);
  } catch (error) {
    throw new SafetyError(`${root}: ${message(error)}`);
  }

  try {
    return await runAgent(sandbox, options, { attempt, harness, scenario }, ids, before, {
      outcome,
      signal,
    });
  } catch (error) {
    // A safety failure, the abort it triggers, or the operator's interrupt ends
    // the evaluation. A run's own failure (a timeout, a failed export) is that
    // run's result.
    if (error instanceof SafetyError || error instanceof InterruptedError || signal.aborted) {
      throw error;
    }
    return outcome({ error: `run failed: ${message(error)}` });
  }
}

/** Run the agent, then grade it. Throws `SafetyError` on an escape. */
async function runAgent(
  sandbox: EvalSandbox,
  options: EvalOptions,
  { scenario, harness }: Run,
  ids: Record<string, string>,
  before: unknown,
  { outcome, signal }: { outcome: (fields: Partial<RunResult>) => RunResult; signal: AbortSignal },
): Promise<RunResult> {
  const root = sandbox.root;
  const model = options.models[harness];
  const started = Date.now();
  let run;
  try {
    run = await capture(agentCommand(harness, scenario.prompt(ids), model, sandbox.root), {
      cwd: sandbox.work,
      env: sandbox.env,
      group: true,
      signal,
      timeout: AGENT_TIMEOUT_MS,
    });
  } finally {
    if (harness === 'codex' && (await settleCodexLogin(sandbox))) {
      process.stderr.write(`  ${root}: Codex refreshed its login; the new token moved back.\n`);
    }
  }
  const durationMs = Date.now() - started;
  await writeFile(join(sandbox.root, 'transcript.jsonl'), run.stdout);
  await writeFile(join(sandbox.root, 'agent.stderr'), run.stderr);

  const transcript =
    harness === 'claude' ? parseClaudeStream(run.stdout) : parseCodexStream(run.stdout);
  const escaped = escapes(transcript.commands, sandbox.binary);
  if (escaped.length > 0) {
    throw new SafetyError(`${root} invoked a mimir outside its sandbox: ${escaped.join(', ')}`);
  }
  const calls = mimirCalls(transcript.commands);
  const after = await exportStore(sandbox, 'store-after');
  const evidence = {
    calls,
    ids,
    mimir: sandbox.mimir,
    storeAfter: after,
    storeChanged: !Bun.deepEquals(before, after),
    transcript,
    work: sandbox.work,
  };
  const checks: CheckResult[] = [];
  for (const check of [...scenario.checks, ...UNIVERSAL_CHECKS]) {
    try {
      checks.push({ name: check.name, passed: await check.test(evidence) });
    } catch (error) {
      checks.push({ error: message(error), name: check.name, passed: false });
    }
  }
  const result = outcome({
    checks,
    durationMs,
    exit: run.exit,
    finalText: transcript.finalText.slice(0, 2000),
    mimirCalls: calls.map((c) =>
      [c.verb, c.sub, c.help ? '--help' : undefined].filter((w) => w !== undefined).join(' '),
    ),
    passed: run.exit === 0 && checks.every((c) => c.passed),
    skills: transcript.skills,
  });
  await privateJson(join(sandbox.root, 'result.json'), result);
  if (result.passed && !options.keep) {
    await rm(sandbox.root, { force: true, recursive: true });
  }
  return result;
}

/**
 * Run `tasks` with at most `limit` in flight. The first failure aborts the
 * shared signal, which stops new starts and kills the agents in flight; the
 * pool then settles and returns what finished, with that first failure.
 */
async function pool<T>(
  tasks: ((signal: AbortSignal) => Promise<T>)[],
  limit: number,
): Promise<{ results: T[]; failure?: unknown }> {
  const controller = new AbortController();
  const results: T[] = [];
  let firstFailure: unknown;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length && !controller.signal.aborted) {
      const task = tasks[next];
      next += 1;
      try {
        if (task !== undefined) {
          results.push(await task(controller.signal));
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          firstFailure = error;
          controller.abort();
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, limit) }, worker));
  return controller.signal.aborted ? { failure: firstFailure, results } : { results };
}

/** The summary table: one row per scenario, one pass-count column per harness. */
export function summarize(results: readonly RunResult[]): string {
  const harnesses = [...new Set(results.map((r) => `${r.harness}:${r.model}`))];
  const scenarios = [...new Set(results.map((r) => r.scenario))];
  const cell = (scenario: string, harness: string): string => {
    const runs = results.filter(
      (r) => r.scenario === scenario && `${r.harness}:${r.model}` === harness,
    );
    return runs.length === 0
      ? '-'
      : `${String(runs.filter((r) => r.passed).length)}/${String(runs.length)}`;
  };
  const total = (harness: string): string => {
    const runs = results.filter((r) => `${r.harness}:${r.model}` === harness);
    return `${String(runs.filter((r) => r.passed).length)}/${String(runs.length)}`;
  };
  const rows = [['scenario', ...harnesses]];
  for (const scenario of scenarios) {
    rows.push([scenario, ...harnesses.map((h) => cell(scenario, h))]);
  }
  rows.push(['total', ...harnesses.map(total)]);
  const widths =
    rows[0]?.map((_, i) => Math.max(...rows.map((row) => (row[i] ?? '').length))) ?? [];
  return rows
    .map((row) =>
      row
        .map((c, i) => c.padEnd(widths[i] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

export class SkillEval {
  readonly repository: string;
  constructor(repository: string) {
    this.repository = realpathSync(repository);
  }

  async run(options: EvalOptions): Promise<string> {
    const unknown = options.scenarios.filter((name) => !SCENARIOS.some((s) => s.name === name));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown scenario: ${unknown.join(', ')}. Known: ${SCENARIOS.map((s) => s.name).join(', ')}`,
      );
    }
    const skill = resolve(this.repository, options.skill);
    if (!existsSync(join(skill, 'SKILL.md'))) {
      throw new Error(`${skill} holds no SKILL.md`);
    }
    const binary =
      options.binary === undefined ? await this.build() : resolve(this.repository, options.binary);
    const id = randomUUID();
    // Runs live outside the checkout: an ancestor `.mimir.toml` would bind the
    // unbound scenarios, and the checkout's own builds would sit within reach.
    const evalRoot = realpathSync(await mkdtemp(join(tmpdir(), 'mimir-skill-eval-')));
    const reports = join(this.repository, '.dev', 'skill-evals', id);
    await mkdir(reports, { mode: 0o700, recursive: true });
    process.stderr.write(`Skill eval ${id}: runs in ${evalRoot}\n`);

    const report = join(reports, 'report.json');
    const writeReport = async (results: RunResult[], failure: unknown) =>
      privateJson(report, {
        binarySha256: await hashFile(binary),
        createdAt: new Date().toISOString(),
        id,
        results,
        skill,
        skillSha256: skillDigest(skill),
        stoppedBy: failure === undefined ? null : message(failure),
        version: 1,
      });
    if (options.harnesses.includes('claude')) {
      try {
        await verifyClaudeShell(join(evalRoot, 'claude-shell-canary'), binary);
      } catch (error) {
        // No scenario ran, so nothing under the root is worth keeping.
        await writeReport([], error);
        await rm(evalRoot, { force: true, recursive: true });
        process.stderr.write(`Report: ${report}\n`);
        throw error;
      }
    }
    const selected = SCENARIOS.filter(
      (s) => options.scenarios.length === 0 || options.scenarios.includes(s.name),
    );
    const tasks = selected.flatMap((scenario) =>
      options.harnesses.flatMap((harness) =>
        Array.from({ length: options.repeat }, (_, i) => (signal: AbortSignal) => {
          process.stderr.write(`  ${scenario.name} · ${harness} · ${String(i + 1)}\n`);
          return runOne(evalRoot, binary, options, { attempt: i + 1, harness, scenario }, signal);
        }),
      ),
    );
    const { results, failure } = await pool(tasks, options.concurrency);
    await writeReport(results, failure);
    if (failure !== undefined) {
      process.stderr.write(`Partial report: ${report}\nRuns kept: ${evalRoot}\n`);
      throw failure;
    }
    const retained = results.filter((r) => !r.passed || options.keep).length;
    if (retained === 0) {
      await rm(evalRoot, { force: true, recursive: true });
    }
    const kept = retained === 0 ? '' : `\nRuns kept for inspection: ${evalRoot}`;
    return `${summarize(results)}\n\nReport: ${report}${kept}`;
  }

  private async build(): Promise<string> {
    await command([process.execPath, 'run', 'build'], { cwd: this.repository, timeout: 600_000 });
    return join(this.repository, 'dist', 'mimir');
  }
}
