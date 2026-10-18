/**
 * Project binding (ADR 0036) — which project a clone belongs to. A clone's
 * project is its git config `mimir.project`; an unbound clone finds it by
 * matching its `origin` remote against project remotes and writes the match
 * back. Transport-free: the CLI, the MCP server, and the Loom CLI each supply a
 * `GitPort` over their own working directory and an Engine for the lookup.
 */
import type { Engine } from '@mimir/contract';

import { validation } from './errors';
import { tryNormalizeRemote } from './remote';

/** The git config key holding a clone's project key. */
export const BINDING_CONFIG_KEY = 'mimir.project';

/** The git operations binding needs, over one clone. Linked worktrees share the clone's config. */
export type GitPort = {
  /** The value of a git config key, or `undefined` when unset or git is unavailable. */
  readConfig: (key: string) => Promise<string | undefined>;
  /** Write a git config key into the clone; `false` when the write failed. */
  writeConfig: (key: string, value: string) => Promise<boolean>;
  /** The `origin` remote URL, or `undefined` when the clone has none. */
  originUrl: () => Promise<string | undefined>;
};

/** The Engine methods binding calls. */
export type BindingEngine = Pick<Engine, 'getNode' | 'projectsByRemote' | 'updateProject'>;

export type Binding =
  | { state: 'bound'; key: string; source: 'git-config' | 'origin' }
  | { state: 'unbound'; reason: 'no-origin' | 'no-match' }
  | { state: 'unbound'; reason: 'ambiguous'; candidates: string[] };

/** The resolved project key of a clone, lazily and at most once per invocation. */
export type ScopeSource = () => Promise<string | undefined>;

/**
 * Resolve a clone's project. Reads git config first; on a miss, matches the
 * origin remote against project remotes and binds only on exactly one match,
 * writing it to git config and calling `notify` once with a line naming the key
 * and its source. A failed config write is silent and the match still binds.
 */
export async function resolveBinding(
  engine: Pick<Engine, 'projectsByRemote'>,
  git: GitPort,
  notify: (line: string) => void,
): Promise<Binding> {
  const configured = (await git.readConfig(BINDING_CONFIG_KEY))?.trim();
  if (configured !== undefined && configured !== '') {
    return { key: configured, source: 'git-config', state: 'bound' };
  }
  const origin = await git.originUrl();
  if (origin === undefined) {
    return { reason: 'no-origin', state: 'unbound' };
  }
  const matches = await engine.projectsByRemote({ remote: origin });
  const [only, second] = matches;
  if (only === undefined) {
    return { reason: 'no-match', state: 'unbound' };
  }
  if (second !== undefined) {
    return { candidates: matches.map((m) => m.id), reason: 'ambiguous', state: 'unbound' };
  }
  if (await git.writeConfig(BINDING_CONFIG_KEY, only.id)) {
    const identity = tryNormalizeRemote(origin) ?? origin;
    notify(`bound to ${only.id} from the origin remote ${identity} (saved in git config)`);
  }
  return { key: only.id, source: 'origin', state: 'bound' };
}

/** What an explicit bind did beyond writing git config. */
export type BindResult = { key: string; recordedRemote?: string };

/**
 * Bind the clone to `key`: write git config, and record the clone's origin on
 * the project when it has no remote. A project that already stores a different
 * remote keeps it. Refuses an unknown project or a failed config write.
 */
export async function bindClone(
  engine: BindingEngine,
  git: GitPort,
  key: string,
): Promise<BindResult> {
  const project = await engine.getNode({ id: key });
  if (project.type !== 'project') {
    throw validation(`${key} is not a project key`, 'bind takes a project KEY such as MMR');
  }
  if (!(await git.writeConfig(BINDING_CONFIG_KEY, key))) {
    throw validation(
      `could not write git config ${BINDING_CONFIG_KEY}`,
      'run mimir bind inside a git clone',
    );
  }
  const origin = await git.originUrl();
  const remote = origin === undefined ? undefined : tryNormalizeRemote(origin);
  if (origin !== undefined && remote !== undefined && (project.remote ?? null) === null) {
    // The Engine normalizes the raw origin on write.
    await engine.updateProject({ id: key, remote: origin });
    return { key, recordedRemote: remote };
  }
  return { key };
}

/**
 * A `ScopeSource` over a clone: resolves the binding on first call and reuses
 * a bound answer after (an unbound clone is re-read, so a later bind applies). `getEngine` is called only then, so a command that never
 * needs a default scope never opens the store.
 */
export function bindingScope(
  getEngine: () => Promise<Pick<Engine, 'projectsByRemote'>>,
  git: GitPort,
  notify: (line: string) => void,
): ScopeSource {
  let resolved: Promise<string | undefined> | undefined;
  let announced = false;
  const resolve = async (): Promise<string | undefined> => {
    const found = await resolveBinding(await getEngine(), git, notify);
    if (found.state === 'unbound' && found.reason === 'ambiguous' && !announced) {
      announced = true;
      notify(
        `several projects match the origin (${found.candidates.join(', ')}): run mimir bind KEY`,
      );
    }
    return found.state === 'bound' ? found.key : undefined;
  };
  return async () => {
    resolved ??= resolve();
    try {
      const key = await resolved;
      if (key === undefined) {
        // Unbound is not final: a later `mimir bind KEY` must reach a long-lived MCP session.
        resolved = undefined;
      }
      return key;
    } catch (error) {
      // Cache only a bound key: a transient failure must not break every later call.
      resolved = undefined;
      throw error;
    }
  };
}
