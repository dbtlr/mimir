import { engineSchemas, MimirError, parseEngineInput } from '@mimir/contract';
import type { Engine, ErrorCode } from '@mimir/contract';
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

/** Adapt an Engine without giving the router access to a Store. */
export function createEngineRouter(engine: Engine) {
  const procedures = {
    artifacts: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.artifacts.input, value))
      .output(engineSchemas.artifacts.output)
      .query(({ input }) => engine.artifacts(input)),
    done: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.done.input, value))
      .output(engineSchemas.done.output)
      .mutation(({ input }) => engine.done(input)),
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
