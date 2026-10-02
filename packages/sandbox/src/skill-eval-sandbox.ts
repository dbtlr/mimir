/**
 * One skill-eval run's disposable world: a vault-sandbox installation of the
 * candidate binary (ADR 0031 — its receipt binds it to owned directories, so
 * it can never reach a live store), a git working copy for the agent, and an
 * agent environment whose PATH resolves `mimir` to that installation alone.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { installBinary } from '../../bin/src/installation/index';
import { readSandboxAuthority } from '../../bin/src/sandbox-authority';
import { command, isolatedEnvironment } from './process';

export type Harness = 'claude' | 'codex';

export type EvalSandbox = {
  root: string;
  work: string;
  binary: string;
  env: NodeJS.ProcessEnv;
  /** Run the sandbox `mimir` in the working copy; resolves stdout, rejects on failure. */
  mimir: (args: string[]) => Promise<string>;
};

/**
 * The agent's PATH: the sandbox's `bin` first, then the caller's PATH minus
 * every directory that holds some other `mimir`, so no shell profile ordering
 * can put a live binary ahead of the candidate.
 */
export function agentPath(sandboxBin: string, callerPath: string): string {
  const rest = callerPath
    .split(':')
    .filter((dir) => dir !== '' && dir !== sandboxBin && !existsSync(join(dir, 'mimir')));
  return [sandboxBin, ...rest].join(':');
}

function agentEnvironment(root: string, harness: Harness): NodeJS.ProcessEnv {
  const env = isolatedEnvironment();
  env.PATH = agentPath(join(root, 'bin'), env.PATH ?? '');
  // A nested harness must not believe it runs inside this session's agent.
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) {
      delete env[key];
    }
  }
  if (harness === 'codex') {
    // Codex reads user skills and AGENTS.md from HOME and CODEX_HOME. Both point
    // into the sandbox; only the login token is linked in.
    env.HOME = join(root, 'home');
    env.CODEX_HOME = join(root, 'codex-home');
  }
  return env;
}

async function git(work: string, args: string[]): Promise<void> {
  await command(['git', '-c', 'user.name=eval', '-c', 'user.email=eval@example.invalid', ...args], {
    cwd: work,
  });
}

/** The operator's Codex login file. */
const codexLogin = (): string =>
  join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');

/** Build the run's world; `files` seeds the working copy and its first commit. */
export async function createEvalSandbox(options: {
  root: string;
  binary: string;
  harness: Harness;
  files: Record<string, string>;
}): Promise<EvalSandbox> {
  await mkdir(options.root, { mode: 0o700, recursive: true });
  const root = realpathSync(options.root);
  const paths = {
    cache: join(root, 'cache', 'mimir'),
    config: join(root, 'config', 'mimir'),
    data: join(root, 'data', 'mimir'),
  };
  for (const path of Object.values(paths)) {
    await mkdir(path, { mode: 0o700, recursive: true });
  }
  const authorityFile = join(root, 'authority.json');
  await writeFile(
    authorityFile,
    `${JSON.stringify({ id: randomUUID(), kind: 'vault', paths, root, version: 1 }, null, 2)}\n`,
    { mode: 0o600 },
  );
  readSandboxAuthority(authorityFile);
  const binary = join(root, 'bin', 'mimir');
  await mkdir(dirname(binary), { mode: 0o700 });
  installBinary({
    registration: { mode: 'sandbox', paths, sandboxAuthority: authorityFile },
    source: options.binary,
    target: binary,
  });

  const work = join(root, 'work');
  for (const [path, content] of Object.entries(options.files)) {
    await mkdir(dirname(join(work, path)), { recursive: true });
    await writeFile(join(work, path), content);
  }
  await mkdir(work, { recursive: true });
  await git(work, ['init', '--quiet', '--initial-branch', 'main']);
  await git(work, ['add', '--all']);
  await git(work, ['commit', '--quiet', '--allow-empty', '--message', 'initial']);

  if (options.harness === 'codex') {
    await mkdir(join(root, 'home'), { mode: 0o700 });
    await mkdir(join(root, 'codex-home'), { mode: 0o700 });
    if (existsSync(codexLogin())) {
      await symlink(codexLogin(), join(root, 'codex-home', 'auth.json'));
    }
  }
  const env = agentEnvironment(root, options.harness);
  return {
    binary,
    env,
    mimir: (args) => command([binary, ...args], { cwd: work, env }),
    root,
    work,
  };
}

/** Install the skill under test where the harness discovers project skills. */
export async function installSkill(sandbox: EvalSandbox, skill: string, harness: Harness) {
  const base = harness === 'claude' ? '.claude' : '.agents';
  await cp(skill, join(sandbox.work, base, 'skills', 'mimir'), { recursive: true });
}

/**
 * Refuse to run an agent unless its shell reaches the sandbox binary. `mimir`
 * must resolve on the agent's PATH to the sandbox (Codex's login zsh may reorder
 * PATH, so it is checked there), and the operator's interactive zsh setup must
 * define no `mimir` alias or function. Claude's actual tool shell is also probed
 * once per evaluation (`verifyClaudeShell` in skill-eval.ts).
 */
export async function assertSandboxResolution(sandbox: EvalSandbox, harness: Harness) {
  const run = (shell: string[], script: string) =>
    command([...shell, script], { cwd: sandbox.work, env: sandbox.env });
  const pathShell = harness === 'codex' ? ['/bin/zsh', '-lc'] : ['/bin/zsh', '-fc'];
  const resolved = (await run(pathShell, 'whence -p mimir')).split('\n').at(-1) ?? '';
  if (resolved === '' || realpathSync(resolved) !== sandbox.binary) {
    throw new Error(`mimir resolves to ${resolved || 'nothing'}, not the sandbox binary`);
  }
  const kind = (await run(['/bin/zsh', '-ic'], 'whence -w mimir')).split('\n').at(-1) ?? '';
  if (kind !== 'mimir: command') {
    throw new Error(`the interactive shell defines ${kind}; refusing to run`);
  }
}

/**
 * After a Codex run, keep the operator's login valid and leave no credential
 * behind. The sandbox links the login in; a token refresh that replaced the
 * link with a file carries the only valid refresh token, so it moves back.
 * Returns whether the login was refreshed.
 */
export async function settleCodexLogin(sandbox: EvalSandbox): Promise<boolean> {
  const linked = join(sandbox.root, 'codex-home', 'auth.json');
  const stat = lstatSync(linked, { throwIfNoEntry: false });
  if (stat === undefined) {
    return false;
  }
  const refreshed = !stat.isSymbolicLink();
  if (refreshed) {
    const staging = `${codexLogin()}.${randomUUID()}.tmp`;
    await copyFile(linked, staging);
    // A login token stays owner-only; copyFile's destination mode is not guaranteed.
    await chmod(staging, 0o600);
    await rename(staging, codexLogin());
  }
  await rm(linked, { force: true });
  return refreshed;
}

/** The sandbox store's facts, without the export timestamp, for before/after comparison. */
export async function exportStore(sandbox: EvalSandbox, name: string): Promise<unknown> {
  const file = join(sandbox.root, `${name}.json`);
  await sandbox.mimir(['store', 'export', file]);
  const facts: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (typeof facts === 'object' && facts !== null && 'exported_at' in facts) {
    const { exported_at: _, ...rest } = facts;
    return rest;
  }
  return facts;
}
