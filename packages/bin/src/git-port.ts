/**
 * The git edge of project binding (ADR 0036): a `GitPort` over one working
 * directory, shelling out to `git`. A linked worktree shares its clone's
 * config, so a binding written from any worktree is read from all of them.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { GitPort } from '@mimir/core';

const run = promisify(execFile);

/** Run `git` in `cwd`; the trimmed stdout, or `undefined` when git fails or is absent. */
async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', args, { cwd, timeout: 5000 });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/** A `GitPort` over the clone containing `cwd`. */
export function gitPortAt(cwd: string): GitPort {
  return {
    originUrl: async () => {
      const url = await git(cwd, ['remote', 'get-url', 'origin']);
      return url === undefined || url === '' ? undefined : url;
    },
    readConfig: async (key) => {
      const value = await git(cwd, ['config', '--local', '--get', key]);
      return value === undefined || value === '' ? undefined : value;
    },
    writeConfig: async (key, value) =>
      (await git(cwd, ['config', '--local', key, value])) !== undefined,
  };
}
