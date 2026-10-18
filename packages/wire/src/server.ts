import { engineSchemas, MimirError, parseEngineInput, UNIFORM_VERBS } from '@mimir/contract';
import type { Engine, EngineNode, ErrorCode, UniformVerb } from '@mimir/contract';
import { formatDiagnostic } from '@mimir/helpers';
import { initTRPC, TRPCError } from '@trpc/server';
import type { TRPCMutationProcedure, TRPCQueryProcedure } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import superjson from 'superjson';

const t = initTRPC.create({
  errorFormatter({ shape, error }) {
    const cause = error.cause;
    const internal = error.code === 'INTERNAL_SERVER_ERROR' && !(cause instanceof MimirError);
    const data = {
      ...shape.data,
      hint: internal ? "run 'mimir doctor'" : undefined,
      mimirError:
        cause instanceof MimirError
          ? { code: cause.code, hint: cause.hint, message: cause.message }
          : null,
    };
    delete data.stack;
    return {
      ...shape,
      data,
      message: internal ? 'the request did not complete' : shape.message,
    };
  },
  transformer: superjson,
});

const domainCodes = {
  conflict: 'CONFLICT',
  invariant: 'INTERNAL_SERVER_ERROR',
  not_found: 'NOT_FOUND',
  validation: 'BAD_REQUEST',
} as const satisfies Record<ErrorCode, string>;

const procedure = t.procedure.use(async ({ next }) => {
  const result = await next();
  if (!result.ok && result.error.cause instanceof MimirError) {
    const cause = result.error.cause;
    throw new TRPCError({ cause, code: domainCodes[cause.code], message: cause.message });
  }
  return result;
});

export type EngineProcedures = {
  [K in keyof Engine]: (typeof engineSchemas)[K]['kind'] extends 'query'
    ? TRPCQueryProcedure<{
        input: Parameters<Engine[K]>[0];
        output: Awaited<ReturnType<Engine[K]>>;
        meta: unknown;
      }>
    : TRPCMutationProcedure<{
        input: Parameters<Engine[K]>[0];
        output: Awaited<ReturnType<Engine[K]>>;
        meta: unknown;
      }>;
};

/** The uniform verbs' procedures, built from the same registry the schemas derive from. */
type UniformProcedures = Pick<EngineProcedures, UniformVerb>;

function uniformProcedures(engine: Engine): UniformProcedures {
  const entries = UNIFORM_VERBS.map((verb) => {
    const run = (input: unknown): Promise<EngineNode> =>
      Reflect.apply(Reflect.get(engine, verb), engine, [input]);
    return [
      verb,
      procedure
        .input((value: unknown) => parseEngineInput(engineSchemas[verb].input, value))
        .output(engineSchemas[verb].output)
        .mutation(({ input }) => run(input)),
    ];
  });
  // Built by iterating exactly UNIFORM_VERBS, so the table has every uniform procedure.
  return Object.fromEntries(entries);
}

/** The node writes' procedures (MMR-517): twelve explicit ones plus the derived uniform verbs. */
function nodeWriteProcedures(engine: Engine) {
  return {
    ...uniformProcedures(engine),
    annotate: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.annotate.input, value))
      .output(engineSchemas.annotate.output)
      .mutation(({ input }) => engine.annotate(input)),
    attach: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.attach.input, value))
      .output(engineSchemas.attach.output)
      .mutation(({ input }) => engine.attach(input)),
    create: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.create.input, value))
      .output(engineSchemas.create.output)
      .mutation(({ input }) => engine.create(input)),
    depend: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.depend.input, value))
      .output(engineSchemas.depend.output)
      .mutation(({ input }) => engine.depend(input)),
    groom: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.groom.input, value))
      .output(engineSchemas.groom.output)
      .mutation(({ input }) => engine.groom(input)),
    move: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.move.input, value))
      .output(engineSchemas.move.output)
      .mutation(({ input }) => engine.move(input)),
    reorder: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.reorder.input, value))
      .output(engineSchemas.reorder.output)
      .mutation(({ input }) => engine.reorder(input)),
    tag: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.tag.input, value))
      .output(engineSchemas.tag.output)
      .mutation(({ input }) => engine.tag(input)),
    undepend: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.undepend.input, value))
      .output(engineSchemas.undepend.output)
      .mutation(({ input }) => engine.undepend(input)),
    untag: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.untag.input, value))
      .output(engineSchemas.untag.output)
      .mutation(({ input }) => engine.untag(input)),
    update: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.update.input, value))
      .output(engineSchemas.update.output)
      .mutation(({ input }) => engine.update(input)),
    updateProject: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.updateProject.input, value))
      .output(engineSchemas.updateProject.output)
      .mutation(({ input }) => engine.updateProject(input)),
  };
}

/** Adapt an Engine without giving the router access to a Store. */
export function createEngineRouter(engine: Engine) {
  const procedures = {
    artifacts: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.artifacts.input, value))
      .output(engineSchemas.artifacts.output)
      .query(({ input }) => engine.artifacts(input)),
    getArtifact: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.getArtifact.input, value))
      .output(engineSchemas.getArtifact.output)
      .query(({ input }) => engine.getArtifact(input)),
    getNode: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.getNode.input, value))
      .output(engineSchemas.getNode.output)
      .query(({ input }) => engine.getNode(input)),
    getSeed: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.getSeed.input, value))
      .output(engineSchemas.getSeed.output)
      .query(({ input }) => engine.getSeed(input)),
    list: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.list.input, value))
      .output(engineSchemas.list.output)
      .query(({ input }) => engine.list(input)),
    next: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.next.input, value))
      .output(engineSchemas.next.output)
      .query(({ input }) => engine.next(input)),
    overview: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.overview.input, value))
      .output(engineSchemas.overview.output)
      .query(({ input }) => engine.overview(input)),
    projects: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.projects.input, value))
      .output(engineSchemas.projects.output)
      .query(({ input }) => engine.projects(input)),
    scratchGet: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.scratchGet.input, value))
      .output(engineSchemas.scratchGet.output)
      .query(({ input }) => engine.scratchGet(input)),
    scratchList: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.scratchList.input, value))
      .output(engineSchemas.scratchList.output)
      .query(({ input }) => engine.scratchList(input)),
    search: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.search.input, value))
      .output(engineSchemas.search.output)
      .query(({ input }) => engine.search(input)),
    seeds: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.seeds.input, value))
      .output(engineSchemas.seeds.output)
      .query(({ input }) => engine.seeds(input)),
    status: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.status.input, value))
      .output(engineSchemas.status.output)
      .query(({ input }) => engine.status(input)),
    tree: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.tree.input, value))
      .output(engineSchemas.tree.output)
      .query(({ input }) => engine.tree(input)),
    ...nodeWriteProcedures(engine),
  } satisfies EngineProcedures;
  return t.router(procedures);
}

export type EngineRouter = ReturnType<typeof createEngineRouter>;

/**
 * A Fetch adapter over the host's store-owning Engine.
 * The mounting host must apply request guards before dispatch, including
 * configured Host filtering and cross-origin write checks.
 */
export function createEngineHandler(engine: Engine, endpoint = '/trpc') {
  const router = createEngineRouter(engine);
  return (req: Request) =>
    fetchRequestHandler({
      createContext: () => ({}),
      endpoint,
      onError({ error }) {
        if (error.code === 'INTERNAL_SERVER_ERROR' && !(error.cause instanceof MimirError)) {
          const cause = error.cause ?? error;
          const diagnostic = formatDiagnostic({
            detail: cause.stack ?? cause.message,
            method: req.method,
            path: new URL(req.url).pathname,
          });
          console.error(`✗ host: request did not complete — ${diagnostic}`);
        }
      },
      req,
      router,
    });
}
