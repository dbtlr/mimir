import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type {
  AnyZodRawShape,
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import { engineSchemas, GROOMING_VALUES, MimirError } from '@mimir/contract';
import type { Engine, EngineNode, EngineTree, FacetName } from '@mimir/contract';
import { z } from 'zod';

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

/** The full names the gate allows from the main agent. */
export const grantToolNames: readonly string[] = GRANT_TOOLS.map(
  (name) => `mcp__${GRANT_SERVER}__${name}`,
);

/** The bounds on a run's planning artifacts (ADR 0041's 2026-11-08 refinement). */
export const ATTACH_LIMITS = { contentCharacters: 100_000, perRun: 5 } as const;

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
};

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
  engineSchemas.seeds.input.pick({ requester: true, sort: true, status: true }).shape,
);
const searchInput = z.strictObject({
  limit: z.number().int().positive().optional(),
  query: z.string(),
});
const annotateInput = z.strictObject({ content: z.string().min(1), id: id.optional() });
const groomInput = z.strictObject({
  ids: z.array(id).min(1).optional(),
  note: z.string().optional(),
  state: z.enum(GROOMING_VALUES),
});
const attachInput = z.strictObject({
  content: z.string(),
  summary: z.string().optional(),
  title: z.string().min(1),
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

/** A record id's form: a project key, `KEY-n`, `KEY-an` (artifact), or `KEY-sn` (seed). */
const RECORD_ID = /^([A-Z]{2,4})(?:-(a|s)?(\d+))?$/;

/**
 * The run grant (ADR 0041): an in-process MCP server for one run. Reads are
 * forced to the run's project; `annotate`, `groom`, and `attach` write only
 * the run's own task or a new artifact linked only to it. No other Engine
 * verb is exposed.
 */
export function createRunGrant(options: RunGrantOptions): McpSdkServerConfigWithInstance {
  const { engine, project, task } = options;
  const inProject = (record: string) => record === project || record.startsWith(`${project}-`);
  let attached = 0;
  let attaching = 0;

  /** Refuse unless `record` is a well-formed id in the run's project. */
  const projectId = (record: string) => {
    const match = RECORD_ID.exec(record);
    if (match === null || match[1] !== project) {
      return refuse(`${record || 'an empty id'} is not a record in ${project}`);
    }
    return match;
  };

  /** Drop every reference that names a record outside the project. */
  const scopeNode = <N extends EngineNode | Omit<EngineTree, 'children'>>(node: N): N => ({
    ...node,
    ...(node.deps === undefined
      ? {}
      : {
          deps: {
            awaitingOn: node.deps.awaitingOn.filter((ref) => inProject(ref.id)),
            blocking: node.deps.blocking.filter((ref) => inProject(ref.id)),
            dependsOn: node.deps.dependsOn.filter((ref) => inProject(ref.id)),
          },
        }),
    ...(node.artifacts === undefined
      ? {}
      : { artifacts: node.artifacts.filter((artifact) => inProject(artifact.id)) }),
    ...(typeof node.upstream === 'string' && !inProject(node.upstream) ? { upstream: null } : {}),
  });
  const scopeTree = (node: EngineTree): EngineTree => ({
    ...scopeNode(node),
    children: node.children.filter((child) => inProject(child.id)).map(scopeTree),
  });
  const scopeLinks = <A extends { links: string[] }>(artifact: A): A => ({
    ...artifact,
    links: artifact.links.filter(inProject),
  });

  const scopeSeed = <S extends { spawned: string[] }>(found: S): S => ({
    ...found,
    spawned: found.spawned.filter(inProject),
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
      `Read one record in ${project}: a task, phase, initiative, the project, an artifact, or a seed.`,
      z.strictObject({ id }),
      async (args) => {
        const match = projectId(args.id);
        if (match[2] === 'a') {
          const artifact = await engine.getArtifact({ content: true, id: args.id });
          return artifact.project === project
            ? scopeLinks(artifact)
            : refuse(`${args.id} is not in ${project}`);
        }
        if (match[2] === 's') {
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
    grantTool('list', `List records in ${project}.`, listInput, async (args) => {
      const set = await engine.list({ ...args, project });
      return { ...set, items: set.items.filter((node) => inProject(node.id)).map(scopeNode) };
    }),
    grantTool(
      'tree',
      `Read the record tree under a record in ${project}; the project when no id is given.`,
      z.strictObject({ id: id.optional() }),
      async (args) => {
        const root = args.id ?? project;
        projectId(root);
        return scopeTree(await engine.tree({ id: root }));
      },
    ),
    grantTool('search', `Search the records of ${project}.`, searchInput, async (args) => {
      const set = await engine.search({ ...args, project });
      return {
        ...set,
        items: set.items.filter((hit) => hit.project === project && inProject(hit.id)),
      };
    }),
    grantTool(
      'artifacts',
      `List the artifacts of ${project}, newest first, without their content.`,
      artifactsInput,
      async (args) => {
        const set = await engine.artifacts({ ...args, project });
        return {
          ...set,
          items: set.items.filter((item) => item.project === project).map(scopeLinks),
        };
      },
    ),
    grantTool(
      'artifact',
      `Read one artifact of ${project} with its content.`,
      z.strictObject({ id }),
      async (args) => {
        const match = projectId(args.id);
        if (match[2] !== 'a') {
          refuse(`${args.id} is not an artifact id`);
        }
        const artifact = await engine.getArtifact({ content: true, id: args.id });
        return artifact.project === project
          ? scopeLinks(artifact)
          : refuse(`${args.id} is not in ${project}`);
      },
    ),
    grantTool('seeds', `List the seeds filed on ${project}.`, seedsInput, async (args) => {
      const list = await engine.seeds({ ...args, project });
      return list.filter((found) => found.project === project).map(scopeSeed);
    }),
    grantTool(
      'annotate',
      `Add a note to ${task}, the task this run works on.`,
      annotateInput,
      async (args) => {
        ownTask(args.id === undefined ? [] : [args.id]);
        await holdRow();
        return engine.annotate({ content: args.content, id: task });
      },
    ),
    grantTool(
      'groom',
      `Set the grooming state of ${task}, with a note. Only while ${task} is todo.`,
      groomInput,
      async (args) => {
        ownTask(args.ids ?? []);
        // The read before the write is the whole guard; the core's groom accepts any lifecycle.
        const current = await engine.getNode({ facets: [], id: task });
        if (current.lifecycle !== 'todo') {
          refuse(`${task} is no longer todo; its grooming state was not changed`);
        }
        await holdRow();
        return engine.groom({
          ids: [task],
          state: args.state,
          ...(args.note === undefined ? {} : { note: args.note }),
        });
      },
    ),
    grantTool(
      'attach',
      `Attach a planning document to ${task}: a title, an optional summary, and Markdown content.`,
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
