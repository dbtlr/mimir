/**
 * Hold an agent skill to the behavior scenarios: run each scenario under each
 * harness in its own vault sandbox, grade the outcome, and report pass rates.
 * The agents are real, so results vary run to run — compare skill revisions on
 * the same scenarios, models, and repeat count, never on a single run.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import { capture, command, hashFile, privateJson } from './process';
import { assertSandboxResolution, createEvalSandbox, installSkill } from './skill-eval-sandbox';
import type { Harness } from './skill-eval-sandbox';
import { SCENARIOS, UNIVERSAL_CHECKS } from './skill-eval-scenarios';
import type { Scenario } from './skill-eval-scenarios';
import { mimirCalls, parseClaudeStream, parseCodexStream } from './skill-eval-transcript';

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

async function runOne(
  evalRoot: string,
  binary: string,
  options: EvalOptions,
  scenario: Scenario,
  harness: Harness,
  attempt: number,
): Promise<RunResult> {
  const sandbox = await createEvalSandbox({
    binary,
    files: scenario.files,
    harness,
    root: join(evalRoot, `${scenario.name}-${harness}-${String(attempt)}`),
  });
  const ids = await scenario.setup(sandbox.mimir);
  if (scenario.bind !== undefined) {
    await sandbox.mimir(['bind', scenario.bind]);
  }
  await installSkill(sandbox, options.skill, harness);
  await assertSandboxResolution(sandbox, harness);

  const model = options.models[harness];
  const started = Date.now();
  const run = await capture(agentCommand(harness, scenario.prompt(ids), model, sandbox.root), {
    cwd: sandbox.work,
    env: sandbox.env,
    timeout: AGENT_TIMEOUT_MS,
  });
  const durationMs = Date.now() - started;
  await writeFile(join(sandbox.root, 'transcript.jsonl'), run.stdout);
  await writeFile(join(sandbox.root, 'agent.stderr'), run.stderr);

  const transcript =
    harness === 'claude' ? parseClaudeStream(run.stdout) : parseCodexStream(run.stdout);
  const calls = mimirCalls(transcript.commands, sandbox.binary);
  const escaped = calls.filter((call) => call.escaped);
  if (escaped.length > 0) {
    throw new Error(
      `Run ${sandbox.root} invoked a mimir outside its sandbox: ${escaped.map((c) => c.command).join(' | ')}`,
    );
  }
  const evidence = { calls, ids, mimir: sandbox.mimir, transcript, work: sandbox.work };
  const checks: CheckResult[] = [];
  for (const check of [...scenario.checks, ...UNIVERSAL_CHECKS]) {
    try {
      checks.push({ name: check.name, passed: await check.test(evidence) });
    } catch (error) {
      checks.push({
        error: error instanceof Error ? error.message : String(error),
        name: check.name,
        passed: false,
      });
    }
  }
  const passed = run.exit === 0 && checks.every((c) => c.passed);
  const result: RunResult = {
    attempt,
    checks,
    durationMs,
    exit: run.exit,
    finalText: transcript.finalText.slice(0, 2000),
    harness,
    mimirCalls: calls.map((c) => [c.verb, c.sub].filter((w) => w !== undefined).join(' ')),
    model: model ?? 'default',
    passed,
    root: sandbox.root,
    scenario: scenario.name,
  };
  await privateJson(join(sandbox.root, 'result.json'), result);
  if (passed && !options.keep) {
    await rm(sandbox.root, { force: true, recursive: true });
  }
  return result;
}

/** Run `tasks` with at most `limit` in flight; the first thrown error stops new starts. */
async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      const task = tasks[index];
      if (task !== undefined) {
        results[index] = await task();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, limit) }, worker));
  return results;
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
    const evalRoot = join(this.repository, '.dev', 'skill-evals', id);
    await mkdir(evalRoot, { mode: 0o700, recursive: true });
    process.stderr.write(`Skill eval ${id}: ${evalRoot}\n`);

    const selected = SCENARIOS.filter(
      (s) => options.scenarios.length === 0 || options.scenarios.includes(s.name),
    );
    const tasks = selected.flatMap((scenario) =>
      options.harnesses.flatMap((harness) =>
        Array.from({ length: options.repeat }, (_, i) => () => {
          process.stderr.write(`  ${scenario.name} · ${harness} · ${String(i + 1)}\n`);
          return runOne(evalRoot, binary, options, scenario, harness, i + 1);
        }),
      ),
    );
    const results = await pool(tasks, options.concurrency);
    const report = join(evalRoot, 'report.json');
    await privateJson(report, {
      binarySha256: await hashFile(binary),
      createdAt: new Date().toISOString(),
      id,
      results,
      skill,
      skillSha256: skillDigest(skill),
      version: 1,
    });
    return `${summarize(results)}\n\nReport: ${report}`;
  }

  private async build(): Promise<string> {
    await command([process.execPath, 'run', 'build'], { cwd: this.repository, timeout: 600_000 });
    return join(this.repository, 'dist', 'mimir');
  }
}
