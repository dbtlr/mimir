import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isolatedEnvironment } from '../../sandbox/src/process';

const entry = fileURLToPath(new URL('../../cli/src/main.ts', import.meta.url));

export type Completed = { exit: number; stderr: string; stdout: string };

/** A running Loom CLI whose stderr can be awaited before it exits. */
export type RunningCli = {
  /** Wait for the exit and collect everything the process wrote. */
  completed: () => Promise<Completed>;
  /** Resolve with the first match of `pattern` in what stderr has shown so far. */
  stderrMatch: (pattern: RegExp) => Promise<RegExpMatchArray>;
};

/**
 * A throwaway CLI-only installation: the Loom CLI runs from source inside its
 * own sandbox authority, in a non-git directory, so no checkout config, repo
 * binding, or live store is reachable.
 */
export type Installation = {
  configFile: string;
  credentialsFile: string;
  /** The directory every run starts in; `store export board.json` lands here. */
  cwd: string;
  /** Kill every child still running, then remove the installation. */
  dispose: () => void;
  /** Run `mimir <args>` to completion. */
  run: (args: readonly string[]) => Promise<Completed>;
  spawn: (args: readonly string[]) => RunningCli;
};

/** A run that outlives this is hung; `mimir pair` would otherwise poll for ten minutes. */
const RUN_DEADLINE_MS = 60_000;

/**
 * Create an installation whose `config.toml` holds `config`. The root is a
 * realpath because the authority refuses a symlinked root (macOS tmpdir is one).
 */
export function createInstallation(config: string): Installation {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mimir-cli-install-')));
  const paths = {
    cache: join(root, 'cache', 'mimir'),
    config: join(root, 'config', 'mimir'),
    data: join(root, 'data', 'mimir'),
  };
  const cwd = join(root, 'work');
  for (const path of [...Object.values(paths), cwd]) {
    mkdirSync(path, { recursive: true });
  }
  const configFile = join(paths.config, 'config.toml');
  writeFileSync(configFile, config);
  const authority = join(root, 'authority.json');
  writeFileSync(
    authority,
    JSON.stringify({ id: randomUUID(), kind: 'local', paths, root, version: 1 }),
  );
  const env = { ...isolatedEnvironment(), MIMIR_SANDBOX_AUTHORITY: authority };

  const children = new Set<Bun.Subprocess>();
  const spawn = (args: readonly string[]) => {
    const child = Bun.spawn([process.execPath, entry, ...args], {
      cwd,
      env,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    });
    children.add(child);
    const timer = setTimeout(() => child.kill('SIGKILL'), RUN_DEADLINE_MS);
    void (async () => {
      try {
        await child.exited;
      } finally {
        clearTimeout(timer);
        children.delete(child);
      }
    })();
    return child;
  };
  const watch = (child: ReturnType<typeof spawn>): RunningCli => {
    let stderr = '';
    let drained = false;
    const draining = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of child.stderr) {
        stderr += decoder.decode(chunk, { stream: true });
      }
      drained = true;
    })();
    return {
      completed: async () => {
        const [stdout, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
        await draining;
        return { exit, stderr, stdout };
      },
      stderrMatch: async (pattern) => {
        for (;;) {
          const match = pattern.exec(stderr);
          if (match !== null) {
            return match;
          }
          // A process that closed stderr without the line will never show it.
          if (drained) {
            throw new Error(`stderr never matched ${String(pattern)}: ${stderr}`);
          }
          await Bun.sleep(25);
        }
      },
    };
  };

  return {
    configFile,
    credentialsFile: join(paths.config, 'credentials.toml'),
    cwd,
    dispose: () => {
      for (const child of children) {
        child.kill('SIGKILL');
      }
      rmSync(root, { force: true, recursive: true });
    },
    run: (args) => watch(spawn(args)).completed(),
    spawn: (args) => watch(spawn(args)),
  };
}
