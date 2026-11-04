import type { T3LaunchInput, T3System } from '../api/fns/t3';
import { T3_RUNTIME_MODES } from '../server/t3-states';
import type { T3OptionChoice, T3Provider, T3RuntimeMode } from '../server/t3-states';

/*
 * The launch's defaults (ADR 0040, Defaults). The browser picks them from the
 * catalog and the last choice for this Mimir project; the server keeps none.
 */

/** A complete launch choice: everything the launch takes except the task and the attempt. */
export type LaunchChoice = Omit<T3LaunchInput, 'attempt' | 'task'>;

/** The part of a launched choice the browser remembers for one Mimir project. */
export type RememberedChoice = {
  instanceId: string;
  model: string;
  options: T3OptionChoice[];
  runtimeMode: T3RuntimeMode;
};

type ReachableSystem = Extract<T3System, { status: 'reachable' }>;

const storageKey = (project: string) => `mimir:t3-launch:${project}`;

const isRuntimeMode = (value: unknown): value is T3RuntimeMode =>
  T3_RUNTIME_MODES.some((mode) => mode === value);

const isOptionChoice = (value: unknown): value is T3OptionChoice =>
  typeof value === 'object' &&
  value !== null &&
  'id' in value &&
  typeof value.id === 'string' &&
  'value' in value &&
  ['boolean', 'number', 'string'].includes(typeof value.value);

function parseRemembered(raw: string): RememberedChoice | null {
  const value: unknown = JSON.parse(raw);
  if (
    typeof value === 'object' &&
    value !== null &&
    'instanceId' in value &&
    typeof value.instanceId === 'string' &&
    'model' in value &&
    typeof value.model === 'string' &&
    'options' in value &&
    Array.isArray(value.options) &&
    value.options.every(isOptionChoice) &&
    'runtimeMode' in value &&
    isRuntimeMode(value.runtimeMode)
  ) {
    return {
      instanceId: value.instanceId,
      model: value.model,
      options: value.options,
      runtimeMode: value.runtimeMode,
    };
  }
  return null;
}

/** The last launched choice for a Mimir project; null when none, or when storage is missing or corrupt. */
export function recallChoice(project: string): RememberedChoice | null {
  try {
    const raw = localStorage.getItem(storageKey(project));
    return raw === null ? null : parseRemembered(raw);
  } catch {
    return null;
  }
}

/** Remember a launched choice for a Mimir project; a storage failure is ignored. */
export function rememberChoice(project: string, choice: LaunchChoice): void {
  const remembered: RememberedChoice = {
    instanceId: choice.model.instanceId,
    model: choice.model.model,
    options: choice.model.options,
    runtimeMode: choice.runtimeMode,
  };
  try {
    localStorage.setItem(storageKey(project), JSON.stringify(remembered));
  } catch {
    // Remembering is a convenience; a full or blocked store only loses it.
  }
}

const findProvider = (system: ReachableSystem, instanceId: string) =>
  system.providers.find((provider) => provider.providerInstanceId === instanceId);

const offers = (system: ReachableSystem, selection: { instanceId: string; model: string }) =>
  findProvider(system, selection.instanceId)?.models.some((m) => m.id === selection.model) ?? false;

/** The project's default model, else the remembered one, when the system still offers it. */
function pickModel(
  system: ReachableSystem,
  projectId: string,
  remembered: RememberedChoice | null,
) {
  const fromProject = system.projects.find(
    (project) => project.id === projectId,
  )?.defaultModelSelection;
  if (fromProject != null && offers(system, fromProject)) {
    return fromProject;
  }
  return remembered !== null && offers(system, remembered) ? remembered : null;
}

/** The first model of the first provider that has one: the dialog's start when nothing is defaulted. */
function firstModel(system: ReachableSystem) {
  for (const provider of system.providers) {
    const model = provider.models[0];
    if (model !== undefined) {
      return { instanceId: provider.providerInstanceId, model: model.id };
    }
  }
  return null;
}

/** Each option whose default is one of its values takes it; the rest are left out. */
export function defaultOptions(
  system: ReachableSystem,
  selection: { instanceId: string; model: string },
): T3OptionChoice[] {
  const model = findProvider(system, selection.instanceId)?.models.find(
    (m) => m.id === selection.model,
  );
  return (model?.options ?? []).flatMap((option) =>
    option.default !== null && option.values.includes(option.default)
      ? [{ id: option.id, value: option.default }]
      : [],
  );
}

/** The broadest runtime mode a provider allows; null when it allows none. */
export function broadestMode(provider: T3Provider): T3RuntimeMode | null {
  return T3_RUNTIME_MODES.toReversed().find((mode) => provider.runtimeModes.includes(mode)) ?? null;
}

/** The remembered runtime mode when the provider still allows it, else the broadest. */
export function pickRuntimeMode(
  provider: T3Provider,
  remembered: RememberedChoice | null,
): T3RuntimeMode | null {
  return remembered !== null && provider.runtimeModes.includes(remembered.runtimeMode)
    ? remembered.runtimeMode
    : broadestMode(provider);
}

/** The system's one matching project; none when several match. */
const singleProject = (system: ReachableSystem) =>
  system.projects.length === 1 ? system.projects[0] : undefined;

function assemble(
  system: ReachableSystem,
  projectId: string,
  selection: { instanceId: string; model: string } | null,
  remembered: RememberedChoice | null,
): LaunchChoice | null {
  const provider = selection === null ? undefined : findProvider(system, selection.instanceId);
  if (selection === null || provider === undefined) {
    return null;
  }
  const runtimeMode = pickRuntimeMode(provider, remembered);
  if (runtimeMode === null) {
    return null;
  }
  return {
    environmentId: system.environmentId,
    interactionMode: 'default',
    model: {
      instanceId: selection.instanceId,
      model: selection.model,
      options: defaultOptions(system, selection),
    },
    projectId,
    runtimeMode,
    workspace: { type: system.defaultThreadEnvMode === 'worktree' ? 'worktree' : 'root' },
  };
}

/** One system's defaults; null when it has no single project, no offered model, or no runtime mode. */
export function defaultsForSystem(
  system: T3System,
  remembered: RememberedChoice | null,
): LaunchChoice | null {
  const project = system.status === 'reachable' ? singleProject(system) : undefined;
  if (system.status !== 'reachable' || project === undefined) {
    return null;
  }
  return assemble(system, project.id, pickModel(system, project.id, remembered), remembered);
}

/**
 * The settings dialog's start for a system: its defaults, with what they
 * cannot pick filled in (no project when several match; the first model when
 * none is defaulted). Null for a system with nothing to launch.
 */
export function startingChoice(
  system: T3System,
  remembered: RememberedChoice | null,
): LaunchChoice | null {
  if (system.status !== 'reachable') {
    return null;
  }
  const projectId = singleProject(system)?.id ?? '';
  const selection = pickModel(system, projectId, remembered) ?? firstModel(system);
  return assemble(system, projectId, selection, remembered);
}

/**
 * The launch's defaults across the catalog's systems: the configured server
 * (listed first) when it is reachable with a matching project, else the only
 * reachable system with one. Null when no system, project, or model can be picked.
 */
export function launchDefaults(
  systems: readonly T3System[],
  remembered: RememberedChoice | null,
): LaunchChoice | null {
  const launchable = systems.filter(
    (system) => system.status === 'reachable' && system.projects.length > 0,
  );
  const [configured] = systems;
  const only = launchable.length === 1 ? launchable[0] : undefined;
  const system = configured !== undefined && launchable.includes(configured) ? configured : only;
  return system === undefined ? null : defaultsForSystem(system, remembered);
}
