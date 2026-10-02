/**
 * One skill-eval run's disposable world: a vault-sandbox installation of the
 * candidate binary (ADR 0031 — its receipt binds it to owned directories, so
 * it can never reach a live store), a git working copy for the agent, and an
 * agent environment whose PATH resolves `mimir` to that installation alone.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { cp, mkdir, symlink, writeFile } from 'node:fs/promises';
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
    const token = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
    if (existsSync(token)) {
      await symlink(token, join(root, 'codex-home', 'auth.json'));
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
 * Refuse to run an agent unless `mimir` resolves to the sandbox binary in the
 * shell that harness uses: Claude's tool shell keeps PATH; Codex runs a login zsh.
 */
export async function assertSandboxResolution(sandbox: EvalSandbox, harness: Harness) {
  const shell = harness === 'codex' ? ['/bin/zsh', '-lc'] : ['/bin/sh', '-c'];
  const resolved = await command([...shell, 'command -v mimir'], {
    cwd: sandbox.work,
    env: sandbox.env,
  });
  if (realpathSync(resolved) !== sandbox.binary) {
    throw new Error(`mimir resolves to ${resolved}, not the sandbox binary; refusing to run`);
  }
}
