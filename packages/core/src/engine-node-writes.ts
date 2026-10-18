import {
  engineSchemas,
  HANDLE_FIELD_KEYS,
  UNIFORM_VERBS,
  intentViews,
  parseEngineInput,
  WRITE_ECHO_FACETS,
} from '@mimir/contract';
import type {
  DataFieldKey,
  Engine,
  EngineInput,
  NodeView,
  EngineOutput,
  UniformArgs,
  UniformVerb,
} from '@mimir/contract';

import { createNode } from './create';
import { deriveSet } from './derive';
import { notFound, validation } from './errors';
import { isSeedRef } from './ids';
import { getArtifact, nodeViewById, projectViewOf } from './intent';
import type { Project } from './model';
import {
  annotate,
  attachArtifact,
  depend,
  groomTasks,
  moveNode,
  reorder,
  resolveAttachTargets,
  tagEntities,
  undepend,
  untagEntities,
  updateNode,
  updateProject,
} from './mutations';
import type { HandleFields } from './mutations';
import { OPS, parseOpChoice, seedOpFor } from './ops';
import { resolveEntityTokenInSet } from './resolve-set';
import type { Store } from './store';

/**
 * The node-write Engine methods (MMR-517) as functions over a Store. Each
 * parses its contract input, runs the existing core mutation, and echoes the
 * written record with the write-echo facets and `Date` instants, like `done`.
 */

const ECHO = new Set(WRITE_ECHO_FACETS);

async function nodeEcho(store: Store, id: string) {
  const view = await nodeViewById(store, id, ECHO);
  if (view === undefined) {
    throw notFound(`${id} doesn't exist`);
  }
  return intentViews.node.parse(view);
}

async function projectEcho(store: Store, project: Project) {
  return intentViews.node.parse(await projectViewOf(store, project, ECHO));
}

/** A blank required text is a refusal in the Engine, so every client gets the same one. */
function requireText(value: string, what: string) {
  if (value.trim() === '') {
    throw validation(`${what} cannot be blank`);
  }
}

export async function createEngine(store: Store, input: EngineInput<'create'>) {
  const parsed = parseEngineInput(engineSchemas.create.input, input);
  if (parsed.type === 'project') {
    return projectEcho(store, await createNode(store, parsed));
  }
  const node = await createNode(store, parsed);
  return nodeEcho(store, node.id);
}

export async function updateEngine(store: Store, input: EngineInput<'update'>) {
  const { id, ...fields } = parseEngineInput(engineSchemas.update.input, input);
  if (typeof fields.upstream === 'string' && !isSeedRef(fields.upstream)) {
    throw validation(
      `upstream expects a seed id (KEY-sN) or null to clear, got ${fields.upstream}`,
    );
  }
  await updateNode(store, id, fields);
  return nodeEcho(store, id);
}

export async function updateProjectEngine(store: Store, input: EngineInput<'updateProject'>) {
  const { id, ...fields } = parseEngineInput(engineSchemas.updateProject.input, input);
  return projectEcho(store, await updateProject(store, id, fields));
}

export async function annotateEngine(store: Store, input: EngineInput<'annotate'>) {
  const { id, content } = parseEngineInput(engineSchemas.annotate.input, input);
  requireText(content, 'annotate content');
  await annotate(store, id, content);
  return nodeEcho(store, id);
}

export async function attachEngine(
  store: Store,
  input: EngineInput<'attach'>,
): Promise<EngineOutput<'attach'>> {
  const {
    content,
    links = [],
    project,
    summary,
    tags,
    title,
  } = parseEngineInput(engineSchemas.attach.input, input);
  if (links.length === 0 && project === undefined) {
    throw validation('attach needs a link or a project');
  }
  requireText(content, 'attach content');
  const targets = await resolveAttachTargets(store, links, project);
  const { renderedId } = await attachArtifact(store, {
    content,
    linkNodeIds: targets.linkNodeIds,
    projectId: targets.projectId,
    summary,
    tags,
    title,
  });
  return intentViews.artifactDetail.parse(await getArtifact(store, renderedId, { content: true }));
}

export async function dependEngine(store: Store, input: EngineInput<'depend'>) {
  const { id, on } = parseEngineInput(engineSchemas.depend.input, input);
  await depend(store, id, on);
  return nodeEcho(store, id);
}

export async function undependEngine(store: Store, input: EngineInput<'undepend'>) {
  const { id, on } = parseEngineInput(engineSchemas.undepend.input, input);
  await undepend(store, id, on);
  return nodeEcho(store, id);
}

export async function moveEngine(store: Store, input: EngineInput<'move'>) {
  const { id, to } = parseEngineInput(engineSchemas.move.input, input);
  await moveNode(store, id, to);
  return nodeEcho(store, id);
}

export async function reorderEngine(store: Store, input: EngineInput<'reorder'>) {
  const parsed = parseEngineInput(engineSchemas.reorder.input, input);
  const ref = 'ref' in parsed ? parsed.ref : null;
  await reorder(store, parsed.id, parsed.position, ref);
  return nodeEcho(store, parsed.id);
}

export async function groomEngine(store: Store, input: EngineInput<'groom'>) {
  const { ids, state, note } = parseEngineInput(engineSchemas.groom.input, input);
  const nodes = await groomTasks(store, ids, state, note);
  const views = await Promise.all(nodes.map((node) => nodeViewById(store, node.id, ECHO)));
  return intentViews.nodes.parse(views.filter((view): view is NodeView => view !== undefined));
}

/** Resolve tag targets (node, project, or artifact ids) against one snapshot. */
async function tagTargets(store: Store, ids: string[]) {
  const set = deriveSet(await store.loadWorkingSet());
  return ids.map((token) => resolveEntityTokenInSet(set, token));
}

export async function tagEngine(store: Store, input: EngineInput<'tag'>) {
  const { ids, tags } = parseEngineInput(engineSchemas.tag.input, input);
  await tagEntities(store, await tagTargets(store, ids), tags);
  return { ids, tags };
}

export async function untagEngine(store: Store, input: EngineInput<'untag'>) {
  const { ids, tags } = parseEngineInput(engineSchemas.untag.input, input);
  const removed = await untagEntities(store, await tagTargets(store, ids), tags);
  return { ids, removed, tags };
}

/** The resume handles a uniform verb's fact declares, read off its parsed arguments. */
function handleArgs(args: UniformArgs, declared: readonly DataFieldKey[]): HandleFields {
  const fields: HandleFields = {};
  for (const key of HANDLE_FIELD_KEYS) {
    const value = args[key];
    if (declared.includes(key) && value !== undefined) {
      fields[key] = value;
    }
  }
  return fields;
}

/**
 * One uniform verb (ADR 0025), driven by its registry entry: the fact names the
 * arguments it takes and the binding runs the core mutation. A seed id on a
 * verb that accepts seeds moves the seed and echoes it.
 */
async function uniformEngine(store: Store, verb: UniformVerb, input: unknown) {
  const spec = OPS[verb];
  const args: UniformArgs = parseEngineInput(engineSchemas[verb].input, input);
  const seedRun = seedOpFor(verb, args.id);
  if (seedRun !== undefined) {
    return intentViews.seed.parse(await seedRun(store, args.id, args.reason));
  }
  const choiceName = spec.choice?.name;
  const choice =
    choiceName === undefined
      ? undefined
      : parseOpChoice(verb, spec, stringOrUndefined(Reflect.get(args, choiceName)));
  const result = await spec.run(
    store,
    args.id,
    args.reason,
    handleArgs(args, spec.fields ?? []),
    choice,
  );
  return 'key' in result ? projectEcho(store, result) : nodeEcho(store, result.id);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The Store a uniform-verb method runs against, read from the Engine that extends the base. */
class UniformVerbMethods {
  declare protected readonly store: Store;
}
for (const verb of UNIFORM_VERBS) {
  Object.defineProperty(UniformVerbMethods.prototype, verb, {
    // Writable and configurable, like a class method.
    configurable: true,
    value(this: UniformVerbMethods, input: unknown) {
      return uniformEngine(this.store, verb, input);
    },
    writable: true,
  });
}

/**
 * The twelve uniform verbs as Engine methods, derived from the operation
 * registry (ADR 0025) rather than written out. `LocalEngine` extends it.
 */
// The loop above installs exactly the UNIFORM_VERBS methods this type names.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
export const UniformEngineBase = UniformVerbMethods as unknown as abstract new () => Pick<
  Engine,
  UniformVerb
>;
