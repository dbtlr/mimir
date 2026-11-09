import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type {
  AnyZodRawShape,
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import { engineSchemas, GROOMING_VALUES, MimirError } from '@mimir/contract';
import type { Engine, EngineNode, EngineTree, FacetName } from '@mimir/contract';
import { parseIdentity } from '@mimir/core';
import { z } from 'zod';

import { CANCELLED_REASON } from './agent-gate';

/** The grant's MCP server name; its tools reach the gate as `mcp__mimir__<tool>`. */
export const GRANT_SERVER = 'mimir';

/** The grant's tools: project-scoped reads, and writes on the run's own task. */
export const GRANT_TOOLS = [
  'get',
  'list',
  'tree',
  'search',
  'artifacts',
  'artifact',
  'seeds',
  'annotate',
  'groom',
  'attach',
] as const;

/**
 * The Engine treats a query shaped like an id or a bare key (`OTH-3`, `oth`)
 * as a lookup in any project, and falls back to text search only when it names
 * nothing (core's `search/intent.ts`). The grant filters a foreign hit out, so
 * an empty answer would tell the run that the foreign record exists. A query
 * that would look outside the project is repeated once, which text search
 * reads as the same terms but the id lookup does not match, so the answer is
 * the project's own text search whether or not the foreign record exists.
 */
const ID_SHAPED = /^([a-z]{2,4})(?:-[as]?\d+)?$/i;
function textOnlyOutside(project: string, query: string): string {
  const trimmed = query.trim();
  const key = ID_SHAPED.exec(trimmed)?.[1]?.toUpperCase();
  return key !== undefined && key !== project ? `${trimmed} ${trimmed}` : query;
}

/**
 * A list or feed with items outside the project removed, counting only what
 * it returns. A correct Engine already scopes these reads, so nothing is
 * removed and its counts stand; a wider answer must not show the foreign count.
 */
function scopedSet<T, S extends { items: T[]; returned: number; total: number }>(
  set: S,
  items: T[],
): S {
  return {
    ...set,
    items,
    returned: items.length,
    total: set.total - (set.items.length - items.length),
  };
}

/** The full names the gate allows from the main agent. */
export const grantToolNames: readonly string[] = GRANT_TOOLS.map(
  (name) => `mcp__${GRANT_SERVER}__${name}`,
);

/** The bounds on a run's planning artifacts (ADR 0041's 2026-11-08 refinement). */
export const ATTACH_LIMITS = {
  contentCharacters: 100_000,
  perRun: 5,
  titleCharacters: 200,
} as const;

/** The longest note `annotate` or `groom` writes: a fifth of an artifact's content. */
export const NOTE_CHARACTERS = 20_000;
/** How many notes and grooming states one run may write; task notes cannot be deleted. */
export const NOTES_PER_RUN = 20;

/**
 * What a read shows in place of a reference to a record in another project.
 * The reference stays, so a task awaiting a foreign blocker still reads as
 * awaiting on something; its id, title, and status do not.
 */
export const OUTSIDE_PROJECT = 'outside this project';

/** What one run's grant is built from. */
export type RunGrantOptions = {
  engine: Engine;
  /** The run's project key; every read is forced to it. */
  project: string;
  /** The run's task id; every write names it and no other record. */
  task: string;
  /** Whether the runner still holds the run's row; checked before every write. */
  checkRow: () => Promise<'held' | 'lost'>;
  /** Called when a write finds the row lost, so the runner aborts the run. */
  onLost: () => void;
  /** Whether the operator has cancelled the run; checked immediately before every write. */
  cancelled: () => boolean;
};

/** The reads' note on references to other projects. */
const REDACTION_NOTE = `A reference to a record in another project reads as "${OUTSIDE_PROJECT}" in place of its id.`;

type ToolResult = Awaited<ReturnType<SdkMcpToolDefinition['handler']>>;

/** A refusal the agent reads: the call did nothing. */
class RefusalError extends Error {
  override name = 'RefusalError';
}

const refuse = (message: string): never => {
  throw new RefusalError(message);
};

/** The facets a grant `get` returns: the cheap ones, plus `home` to check the project. */
const GET_FACETS: FacetName[] = [
  'deps',
  'description',
  'next',
  'tags',
  'children',
  'distribution',
  'annotations',
  'artifacts',
  'home',
  'lede',
];

/*
 * Input schemas. Each is strict: a key the schema does not name refuses the
 * call. The reads take the Engine's own fields minus `project`, which the
 * grant supplies.
 */
const id = z.string();
const listInput = z.strictObject(
  engineSchemas.list.input.pick({
    limit: true,
    offset: true,
    priority: true,
    q: true,
    size: true,
    status: true,
    tag: true,
  }).shape,
);
const artifactsInput = z.strictObject(
  engineSchemas.artifacts.input.pick({ limit: true, offset: true, q: true, tag: true }).shape,
);
const seedsInput = z.strictObject(
  // No requester filter: it would probe which other boards filed seeds here.
  engineSchemas.seeds.input.pick({ sort: true, status: true }).shape,
);
const searchInput = z.strictObject({
  limit: z.number().int().positive().optional(),
  query: z.string(),
});
const note = z.string().max(NOTE_CHARACTERS);
const annotateInput = z.strictObject({ content: note.min(1), id: id.optional() });
const groomInput = z.strictObject({
  ids: z.array(id).min(1).optional(),
  note: note.optional(),
  state: z.enum(GROOMING_VALUES),
});
const attachInput = z.strictObject({
  content: z.string(),
  // The core already refuses a summary over its own limit.
  summary: z.string().optional(),
  title: z.string().min(1).max(ATTACH_LIMITS.titleCharacters),
});

/**
 * One grant tool with a strict object schema. The SDK's `tool` types take a
 * raw shape, which validates by stripping unknown keys; its server passes a
 * full schema through to MCP's validation unchanged, which refuses them.
 */
function grantTool<T extends z.ZodObject>(
  name: (typeof GRANT_TOOLS)[number],
  description: string,
  schema: T,
  run: (args: z.output<T>) => Promise<unknown>,
): SdkMcpToolDefinition {
  // The SDK's server accepts any Zod object schema; only its types insist on a raw shape.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const inputSchema = schema as unknown as AnyZodRawShape;
  return tool(name, description, inputSchema, async (args): Promise<ToolResult> => {
    try {
      // Parsed again here, so the handler never runs on input the schema refuses.
      const result = await run(schema.parse(args));
      return { content: [{ text: JSON.stringify(result), type: 'text' }] };
    } catch (error) {
      return { content: [{ text: refusalText(error), type: 'text' }], isError: true };
    }
  });
}

/** What the agent reads when a call fails: a refusal or the board's own error, never a stack. */
function refusalText(error: unknown): string {
  if (error instanceof RefusalError || error instanceof MimirError) {
    return error.message;
  }
  if (error instanceof z.ZodError) {
    return 'the arguments do not match this tool';
  }
  return 'the board could not answer this call';
}

/**
 * The run grant (ADR 0041): an in-process MCP server for one run. Reads are
 * forced to the run's project; `annotate`, `groom`, and `attach` write only
 * the run's own task or a new artifact linked only to it. No other Engine
 * verb is exposed.
 */
export function createRunGrant(options: RunGrantOptions): McpSdkServerConfigWithInstance {
  const { engine, project, task } = options;
  const inProject = (record: string) => record === project || record.startsWith(`${project}-`);
  const withinProject = (query: string) => textOnlyOutside(project, query);
  let attached = 0;
  let attaching = 0;
  let noted = 0;

  /**
   * Count one note or grooming write against the run's limit, before the first
   * await, so concurrent calls cannot pass the limit together.
   */
  const countNote = () => {
    if (noted >= NOTES_PER_RUN) {
      refuse(
        `a run writes at most ${NOTES_PER_RUN} notes and grooming states; nothing was written`,
      );
    }
    noted += 1;
  };

  /** Refuse unless `record` is a well-formed id in the run's project. */
  const projectId = (record: string) => {
    const identity = parseIdentity(record);
    if (identity === null || identity.key !== project) {
      return refuse(`${record || 'an empty id'} is not a record in ${project}`);
    }
    return identity;
  };

  /** A reference id, or the redaction marker when it names another project. */
  const scopeId = (record: string) => (inProject(record) ? record : OUTSIDE_PROJECT);
  /** A reference, or a bare marker standing in for one to another project. */
  const scopeRef = <R extends { id: string; via?: string }>(ref: R): R | { id: string } =>
    inProject(ref.id)
      ? ref
      : {
          id: OUTSIDE_PROJECT,
          // An inherited edge's ancestor is in the project even when its prerequisite is not.
          ...(ref.via !== undefined && inProject(ref.via) ? { via: ref.via } : {}),
        };

  /** Redact every reference that names a record outside the project. */
  const scopeNode = <N extends EngineNode | Omit<EngineTree, 'children'>>(node: N): N => ({
    ...node,
    ...(node.deps === undefined
      ? {}
      : {
          deps: {
            awaitingOn: node.deps.awaitingOn.map(scopeRef),
            blocking: node.deps.blocking.map(scopeRef),
            dependsOn: node.deps.dependsOn.map(scopeRef),
          },
        }),
    ...(node.artifacts === undefined
      ? {}
      : {
          artifacts: node.artifacts.map((artifact) =>
            inProject(artifact.id)
              ? artifact
              : {
                  createdAt: artifact.createdAt,
                  id: OUTSIDE_PROJECT,
                  tags: [],
                  title: OUTSIDE_PROJECT,
                },
          ),
        }),
    ...(typeof node.upstream === 'string' ? { upstream: scopeId(node.upstream) } : {}),
  });
  // Children of another project are left out, not redacted: the tree is the project's own.
  const scopeTree = (node: EngineTree): EngineTree => ({
    ...scopeNode(node),
    children: node.children.filter((child) => inProject(child.id)).map(scopeTree),
  });
  const scopeLinks = <A extends { links: string[] }>(artifact: A): A => ({
    ...artifact,
    links: artifact.links.map(scopeId),
  });

  const scopeSeed = <S extends { requester: string | null; spawned: string[] }>(found: S): S => ({
    ...found,
    // A requester is a project key; another board's key reads as the marker.
    requester:
      found.requester === null || found.requester === project ? found.requester : OUTSIDE_PROJECT,
    spawned: found.spawned.map(scopeId),
  });

  /** Check the run's row; a lost row refuses the write and tells the runner. */
  const holdRow = async (): Promise<void> => {
    // A check that fails refuses the write, as a lost row does, but is not a loss.
    const row = await options.checkRow().catch(() => 'unknown' as const);
    if (row === 'unknown') {
      refuse('the run could not confirm it still holds its row; nothing was written');
    }
    if (row !== 'held') {
      options.onLost();
      refuse('the run no longer holds its row; nothing was written');
    }
  };

  /**
   * Refuse once the run is cancelled. Called immediately before each write
   * verb, with no await between, so a write that passes it was not cancelled
   * when it was sent.
   */
  const notCancelled = () => {
    if (options.cancelled()) {
      refuse(`${CANCELLED_REASON}; nothing was written`);
    }
  };

  /** Refuse unless every id names the run's task. */
  const ownTask = (ids: readonly string[]) => {
    const stray = ids.find((record) => record !== task);
    if (stray !== undefined) {
      refuse(`this run may write only ${task}, not ${stray || 'an empty id'}; nothing was written`);
    }
  };

  const tools = [
    grantTool(
      'get',
      `Read one record in ${project}: a task, phase, initiative, the project, an artifact, or a seed. ${REDACTION_NOTE}`,
      z.strictObject({ id }),
      async (args) => {
        const identity = projectId(args.id);
        if (identity.kind === 'artifact') {
          const artifact = await engine.getArtifact({ content: true, id: args.id });
          return artifact.project === project
            ? scopeLinks(artifact)
            : refuse(`${args.id} is not in ${project}`);
        }
        if (identity.kind === 'seed') {
          const found = await engine.getSeed({ content: true, id: args.id });
          return found.project === project
            ? scopeSeed(found)
            : refuse(`${args.id} is not in ${project}`);
        }
        const node = await engine.getNode({ facets: GET_FACETS, id: args.id });
        if (node.type !== 'project' && node.home?.projectKey !== project) {
          refuse(`${args.id} is not in ${project}`);
        }
        return scopeNode(node);
      },
    ),
    grantTool('list', `List records in ${project}. ${REDACTION_NOTE}`, listInput, async (args) => {
      const set = await engine.list({ ...args, project });
      return scopedSet(set, set.items.filter((node) => inProject(node.id)).map(scopeNode));
    }),
    grantTool(
      'tree',
      `Read the record tree under a record in ${project}; the project when no id is given. ${REDACTION_NOTE}`,
      z.strictObject({ id: id.optional() }),
      async (args) => {
        const root = args.id ?? project;
        projectId(root);
        return scopeTree(await engine.tree({ id: root }));
      },
    ),
    grantTool(
      'search',
      `Search the records of ${project} by id, title, or description.`,
      searchInput,
      async (args) => {
        const set = await engine.search({ ...args, project, query: withinProject(args.query) });
        // A link hit names which record links the match, and an id query can reach
        // another project, so only direct in-project hits are kept and counted.
        const items = set.items.filter(
          (hit) => hit.match !== 'link' && hit.project === project && inProject(hit.id),
        );
        return { ...set, items, returned: items.length, startsAt: 0, total: items.length };
      },
    ),
    grantTool(
      'artifacts',
      `List the artifacts of ${project}, newest first, without their content. ${REDACTION_NOTE}`,
      artifactsInput,
      async (args) => {
        const set = await engine.artifacts({ ...args, project });
        return scopedSet(set, set.items.filter((item) => item.project === project).map(scopeLinks));
      },
    ),
    grantTool(
      'artifact',
      `Read one artifact of ${project} with its content. ${REDACTION_NOTE}`,
      z.strictObject({ id }),
      async (args) => {
        if (projectId(args.id).kind !== 'artifact') {
          refuse(`${args.id} is not an artifact id`);
        }
        const artifact = await engine.getArtifact({ content: true, id: args.id });
        return artifact.project === project
          ? scopeLinks(artifact)
          : refuse(`${args.id} is not in ${project}`);
      },
    ),
    grantTool(
      'seeds',
      `List the seeds filed on ${project}. ${REDACTION_NOTE}`,
      seedsInput,
      async (args) => {
        const list = await engine.seeds({ ...args, project });
        return list.filter((found) => found.project === project).map(scopeSeed);
      },
    ),
    grantTool(
      'annotate',
      `Add a note to ${task}, the task this run works on. The note is at most ${NOTE_CHARACTERS} characters; a run writes at most ${NOTES_PER_RUN} notes and grooming states.`,
      annotateInput,
      async (args) => {
        ownTask(args.id === undefined ? [] : [args.id]);
        countNote();
        await holdRow();
        notCancelled();
        return engine.annotate({ content: args.content, id: task });
      },
    ),
    grantTool(
      'groom',
      `Set the grooming state of ${task}, with a note of at most ${NOTE_CHARACTERS} characters. Only while ${task} is todo; a run writes at most ${NOTES_PER_RUN} notes and grooming states.`,
      groomInput,
      async (args) => {
        ownTask(args.ids ?? []);
        countNote();
        await holdRow();
        // The read just before the write is the whole guard; the core's groom accepts any
        // lifecycle. ADR 0041 accepts the remaining window: a state set on a task that has
        // just left todo is read by no view.
        const current = await engine.getNode({ facets: [], id: task });
        if (current.lifecycle !== 'todo') {
          refuse(`${task} is no longer todo; its grooming state was not changed`);
        }
        notCancelled();
        return engine.groom({
          ids: [task],
          state: args.state,
          ...(args.note === undefined ? {} : { note: args.note }),
        });
      },
    ),
    grantTool(
      'attach',
      `Attach a planning document to ${task}: a title of at most ${ATTACH_LIMITS.titleCharacters} characters, an optional one-line summary, and Markdown content of at most ${ATTACH_LIMITS.contentCharacters}. A run attaches at most ${ATTACH_LIMITS.perRun}.`,
      attachInput,
      async (args) => {
        // An image would load from its URL in the console and could carry what the run read.
        if ([args.title, args.summary ?? '', args.content].some((text) => text.includes('!['))) {
          refuse(
            'an artifact from an agent run cannot contain Markdown images (![); nothing was written',
          );
        }
        if (args.content.length > ATTACH_LIMITS.contentCharacters) {
          refuse(
            `content is over ${ATTACH_LIMITS.contentCharacters} characters; nothing was written`,
          );
        }
        // Counted before the first await, so concurrent calls cannot pass the limit together.
        if (attached + attaching >= ATTACH_LIMITS.perRun) {
          refuse(`a run attaches at most ${ATTACH_LIMITS.perRun} artifacts; nothing was written`);
        }
        attaching += 1;
        try {
          await holdRow();
          notCancelled();
          const artifact = await engine.attach({
            content: args.content,
            links: [task],
            project,
            tags: ['plan'],
            title: args.title,
            ...(args.summary === undefined ? {} : { summary: args.summary }),
          });
          attached += 1;
          return artifact;
        } finally {
          attaching -= 1;
        }
      },
    ),
  ];
  return createSdkMcpServer({ name: GRANT_SERVER, tools, version: '1.0.0' });
}
