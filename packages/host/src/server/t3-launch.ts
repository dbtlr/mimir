import type { T3LaunchRequest } from './t3-input';
import type { T3LaunchedThread, T3LaunchField, T3System } from './t3-states';

/*
 * The launch's host-memory parts and pure checks (ADR 0040, Launch): the
 * attempt registry, one launch per task at a time, and the step-2 checks of a
 * choice against the system it names. The adapter in t3.ts runs the steps.
 */

/** How long the host remembers an attempt, and how many it keeps. */
export const ATTEMPT_TTL_MS = 24 * 60 * 60 * 1000;
export const ATTEMPT_CAP = 256;

/** The launch choice an attempt is bound to: every input field but the task and the attempt. */
export function choiceKey(input: T3LaunchRequest): string {
  const { model, workspace } = input;
  return JSON.stringify({
    environmentId: input.environmentId,
    interactionMode: input.interactionMode,
    model: {
      instanceId: model.instanceId,
      model: model.model,
      // Order carries no meaning: the same options in another order are the same choice.
      options: model.options
        .map((option) => [option.id, option.value] as const)
        .toSorted(([a], [b]) => a.localeCompare(b)),
    },
    projectId: input.projectId,
    runtimeMode: input.runtimeMode,
    workspace: { branch: workspace.branch ?? null, type: workspace.type },
  });
}

type AttemptEntry = {
  task: string;
  choice: string;
  createdAt: number;
  /** Set once T3 answers with the thread. */
  thread?: T3LaunchedThread;
};

/**
 * The attempts the host has sent to T3, each with its task, its checked
 * choice, and the thread once T3 answers. Entries live 24 hours, at most 256
 * are kept, and a new one evicts the oldest. Nothing survives a restart.
 */
export function createAttemptRegistry(clock: () => number) {
  const attempts = new Map<string, AttemptEntry>();
  const live = (entry: AttemptEntry) => clock() - entry.createdAt < ATTEMPT_TTL_MS;
  const read = (attempt: string) => {
    const entry = attempts.get(attempt);
    if (entry !== undefined && !live(entry)) {
      attempts.delete(attempt);
      return undefined;
    }
    return entry;
  };
  return {
    /** Whether the attempt is known with another task or another choice. */
    conflicts: (attempt: string, task: string, choice: string): boolean => {
      const entry = read(attempt);
      return entry !== undefined && (entry.task !== task || entry.choice !== choice);
    },
    /** Remember an attempt about to be sent to T3; a known one keeps its entry. */
    remember: (attempt: string, task: string, choice: string): void => {
      if (read(attempt) !== undefined) {
        return;
      }
      for (const [key, held] of attempts) {
        if (!live(held)) {
          attempts.delete(key);
        }
      }
      while (attempts.size >= ATTEMPT_CAP) {
        const oldest = attempts.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        attempts.delete(oldest);
      }
      attempts.set(attempt, { choice, createdAt: clock(), task });
    },
    /** Record the thread T3 answered for a remembered attempt. */
    settle: (attempt: string, thread: T3LaunchedThread): void => {
      const entry = read(attempt);
      if (entry !== undefined) {
        entry.thread = thread;
      }
    },
    /** The thread a known attempt reached, if T3 has answered it. */
    thread: (attempt: string): T3LaunchedThread | undefined => read(attempt)?.thread,
  };
}

/** Run one task's launches one at a time: a second waits for the first to settle. */
export function createTaskLocks() {
  // Each task's last launch, settled either way; a new launch waits on it.
  const tails = new Map<string, Promise<void>>();
  return async <T>(task: string, run: () => Promise<T>): Promise<T> => {
    const previous = tails.get(task);
    const current = (async () => {
      await previous;
      return run();
    })();
    const tail = (async () => {
      try {
        await current;
      } catch {
        // The launch's own caller receives its failure; the next launch only waits.
      }
    })();
    tails.set(task, tail);
    try {
      return await current;
    } finally {
      if (tails.get(task) === tail) {
        tails.delete(task);
      }
    }
  };
}

const BRANCH_TEXT = /^[A-Za-z0-9._/-]{1,200}$/;

/**
 * Whether `branch` is a branch name a launch may ask for: 1 to 200 of
 * `[A-Za-z0-9._/-]`, not starting with `-`, not `HEAD`; each `/` component
 * non-empty, starting with no `.`, ending with neither `.` nor `.lock`, and
 * holding no `..`.
 */
export function isLaunchBranch(branch: string): boolean {
  if (!BRANCH_TEXT.test(branch) || branch.startsWith('-') || branch === 'HEAD') {
    return false;
  }
  return branch
    .split('/')
    .every(
      (part) =>
        part !== '' &&
        !part.startsWith('.') &&
        !part.endsWith('.') &&
        !part.endsWith('.lock') &&
        !part.includes('..'),
    );
}

/**
 * The first field of a choice the system does not offer (step 2), or
 * undefined when every field is one it offers. `system` is the chosen
 * system's catalog entry, undefined when it has no matching project.
 */
export function invalidField(
  input: T3LaunchRequest,
  system: Extract<T3System, { status: 'reachable' }> | undefined,
): T3LaunchField | undefined {
  if (system?.projects.some((project) => project.id === input.projectId) !== true) {
    return 'projectId';
  }
  const provider = system.providers.find(
    (offered) => offered.providerInstanceId === input.model.instanceId,
  );
  const model = provider?.models.find((offered) => offered.id === input.model.model);
  if (provider === undefined || model === undefined) {
    return 'model';
  }
  const seen = new Set<string>();
  for (const choice of input.model.options) {
    const option = model.options.find((offered) => offered.id === choice.id);
    if (seen.has(choice.id) || option === undefined || !option.values.includes(choice.value)) {
      return 'options';
    }
    seen.add(choice.id);
  }
  if (!provider.runtimeModes.includes(input.runtimeMode)) {
    return 'runtimeMode';
  }
  const { branch, type } = input.workspace;
  if (branch !== undefined && (type !== 'worktree' || !isLaunchBranch(branch))) {
    return 'branch';
  }
  return undefined;
}
