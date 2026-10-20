// Shared test seam module, not a test body.
// oxlint-disable vitest/require-hook
import type { EngineNode, EngineSearchHit, EngineTree } from '@mimir/contract';

import {
  archive,
  consoleSearch,
  create,
  projects,
  tree,
  unarchive,
  updateProject,
} from '../api/fns/shell';
import { engineNode, engineProject, engineTree, searchSet } from './engine-fixtures';

/*
 * The shell's server functions served from a small world. A test file that
 * renders anything reading the shell's queries mocks the module first —
 * `vi.mock('../api/fns/shell')` at the top of the file — and then calls
 * `serveShell`, which answers each function from the world it is given. A case
 * that needs one answer of its own overrides that function after, with
 * `vi.mocked(fn).mockResolvedValueOnce(...)` or `.mockRejectedValueOnce(...)`,
 * and asserts the call by function: `expect(create).toHaveBeenCalledWith({
 * data: {...} })`. See setup.ts for the pattern.
 */

export type ShellWorld = {
  /** The active project list. */
  projects: EngineNode[];
  /** The archived shelf. */
  archived: EngineNode[];
  /** Trees by project key; a key without one answers a bare project root. */
  trees: Record<string, EngineTree>;
  /** What every search answers. */
  hits: EngineSearchHit[];
};

/** Answer the shell's server functions from `world`; the returned state is live. */
export function serveShell(world: Partial<ShellWorld> = {}): ShellWorld {
  const state: ShellWorld = { archived: [], hits: [], projects: [], trees: {}, ...world };
  const projectOf = (key: string): EngineNode =>
    [...state.projects, ...state.archived].find((p) => p.id === key) ?? engineProject({ id: key });
  vi.mocked(projects).mockImplementation(async ({ data }) =>
    data.status === 'archived' ? state.archived : state.projects,
  );
  vi.mocked(tree).mockImplementation(
    async ({ data }) =>
      state.trees[data.id] ?? engineTree({ id: data.id, status: 'ready', type: 'project' }),
  );
  vi.mocked(consoleSearch).mockImplementation(async () => searchSet(state.hits));
  vi.mocked(create).mockImplementation(async ({ data }) =>
    data.type === 'project'
      ? engineProject({ id: data.key, title: data.name })
      : engineNode({ parent: data.parent, status: 'ready', title: data.title, type: data.type }),
  );
  vi.mocked(updateProject).mockImplementation(async ({ data }) => projectOf(data.id));
  vi.mocked(archive).mockImplementation(async ({ data }) => ({
    ...projectOf(data.id),
    released: [],
  }));
  vi.mocked(unarchive).mockImplementation(async ({ data }) => projectOf(data.id));
  return state;
}

/** Every shell read fails, as when the host cannot be reached. */
export function failShellReads(error: Error = new Error('unreachable')): void {
  vi.mocked(projects).mockRejectedValue(error);
  vi.mocked(tree).mockRejectedValue(error);
  vi.mocked(consoleSearch).mockRejectedValue(error);
}
