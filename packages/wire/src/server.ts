import { engineSchemas, MimirError, parseEngineInput } from '@mimir/contract';
import type { Engine, ErrorCode } from '@mimir/contract';
import { initTRPC, TRPCError } from '@trpc/server';
import type { TRPCMutationProcedure, TRPCQueryProcedure } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import superjson from 'superjson';

const t = initTRPC.create({
  errorFormatter({ shape, error }) {
    const cause = error.cause;
    return {
      ...shape,
      data: {
        ...shape.data,
        mimirError:
          cause instanceof MimirError
            ? { code: cause.code, hint: cause.hint, message: cause.message }
            : null,
      },
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
    done: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.done.input, value))
      .output(engineSchemas.done.output)
      .mutation(({ input }) => engine.done(input)),
    getNode: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.getNode.input, value))
      .output(engineSchemas.getNode.output)
      .query(({ input }) => engine.getNode(input)),
  } satisfies EngineProcedures;
  return t.router(procedures);
}

export type EngineRouter = ReturnType<typeof createEngineRouter>;

/** A Fetch adapter; hosts supply the store-owning Engine and mount the endpoint. */
export function createEngineHandler(engine: Engine, endpoint = '/trpc') {
  const router = createEngineRouter(engine);
  return (req: Request) =>
    fetchRequestHandler({ createContext: () => ({}), endpoint, req, router });
}
