import {
  consoleSchemas,
  engineSchemas,
  MimirError,
  MIN_CLIENT,
  parseEngineInput,
  UNIFORM_VERBS,
} from '@mimir/contract';
import type {
  ConsoleEngine,
  Engine,
  EngineMethods,
  EngineOutput,
  ErrorCode,
  UniformVerb,
} from '@mimir/contract';
import { describeFault, formatDiagnostic } from '@mimir/helpers';
import { getTRPCErrorShape, initTRPC, transformTRPCResponse, TRPCError } from '@trpc/server';
import type { TRPCMutationProcedure, TRPCQueryProcedure } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { lt, parse } from 'semver';
import superjson from 'superjson';

type VersionContext = { clientVersion: string | null; hostVersion: string };

const t = initTRPC.context<VersionContext>().create({
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

const procedure = t.procedure
  .use(async ({ next }) => {
    const result = await next();
    if (!result.ok && result.error.cause instanceof MimirError) {
      const cause = result.error.cause;
      throw new TRPCError({ cause, code: domainCodes[cause.code], message: cause.message });
    }
    return result;
  })
  .use(({ ctx, next }) => {
    const refusal = versionRefusal(ctx);
    if (refusal) {
      throw refusal;
    }
    return next();
  });

function versionRefusal(ctx: VersionContext): MimirError | undefined {
  if (!ctx.clientVersion) {
    return new MimirError(
      'validation',
      'missing x-mimir-version header; client is outside the version window',
      'update this CLI',
    );
  }
  const client = parse(ctx.clientVersion);
  if (!client) {
    return new MimirError(
      'validation',
      'invalid x-mimir-version header; client is outside the version window',
      'update this CLI',
    );
  }
  if (lt(client, MIN_CLIENT)) {
    return new MimirError(
      'validation',
      `client ${ctx.clientVersion} is older than the minimum supported client ${MIN_CLIENT}`,
      'update this CLI',
    );
  }
  const host = parse(ctx.hostVersion);
  if (
    host &&
    (client.major > host.major || (client.major === host.major && client.minor > host.minor))
  ) {
    return new MimirError(
      'validation',
      `client ${ctx.clientVersion} is newer than host ${ctx.hostVersion} by minor version`,
      'update the host first',
    );
  }
  return undefined;
}

export type EngineProcedures = {
  [K in keyof EngineMethods]: (typeof engineSchemas)[K]['kind'] extends 'query'
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
} & {
  console: {
    [K in keyof ConsoleEngine]: TRPCQueryProcedure<{
      input: Parameters<ConsoleEngine[K]>[0];
      output: Awaited<ReturnType<ConsoleEngine[K]>>;
      meta: unknown;
    }>;
  };
};

/** The uniform verbs' procedures, built from the same registry the schemas derive from. */
type UniformProcedures = Pick<EngineProcedures, UniformVerb>;

function uniformProcedures(engine: Engine): UniformProcedures {
  const entries = UNIFORM_VERBS.map((verb) => {
    const run = (input: unknown): Promise<EngineOutput<UniformVerb>> =>
      Reflect.apply(Reflect.get(engine, verb), engine, [input]);
    return [
      verb,
      procedure
        .input((value: unknown) => parseEngineInput(engineSchemas[verb].input, value))
        .output(engineSchemas[verb].output)
        .mutation(({ input }) => run(input)),
    ] as const;
  });
  // Built by iterating exactly UNIFORM_VERBS, so the table has every uniform procedure.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return Object.fromEntries(entries) as unknown as UniformProcedures;
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
    updateArtifact: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.updateArtifact.input, value))
      .output(engineSchemas.updateArtifact.output)
      .mutation(({ input }) => engine.updateArtifact(input)),
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
    console: t.router({
      nodeWork: procedure
        .input((value: unknown) => parseEngineInput(consoleSchemas.nodeWork.input, value))
        .output(consoleSchemas.nodeWork.output)
        .query(({ input }) => engine.console.nodeWork(input)),
      openTasks: procedure
        .input((value: unknown) => parseEngineInput(consoleSchemas.openTasks.input, value))
        .output(consoleSchemas.openTasks.output)
        .query(({ input }) => engine.console.openTasks(input)),
      overview: procedure
        .input((value: unknown) => parseEngineInput(consoleSchemas.overview.input, value))
        .output(consoleSchemas.overview.output)
        .query(({ input }) => engine.console.overview(input)),
      projectWork: procedure
        .input((value: unknown) => parseEngineInput(consoleSchemas.projectWork.input, value))
        .output(consoleSchemas.projectWork.output)
        .query(({ input }) => engine.console.projectWork(input)),
      review: procedure
        .input((value: unknown) => parseEngineInput(consoleSchemas.review.input, value))
        .output(consoleSchemas.review.output)
        .query(({ input }) => engine.console.review(input)),
      search: procedure
        .input((value: unknown) => parseEngineInput(consoleSchemas.search.input, value))
        .output(consoleSchemas.search.output)
        .query(({ input }) => engine.console.search(input)),
      upstreamTasks: procedure
        .input((value: unknown) => parseEngineInput(consoleSchemas.upstreamTasks.input, value))
        .output(consoleSchemas.upstreamTasks.output)
        .query(({ input }) => engine.console.upstreamTasks(input)),
    }),
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
    projectsByRemote: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.projectsByRemote.input, value))
      .output(engineSchemas.projectsByRemote.output)
      .query(({ input }) => engine.projectsByRemote(input)),
    scratchAgendaAdd: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.scratchAgendaAdd.input, value))
      .output(engineSchemas.scratchAgendaAdd.output)
      .mutation(({ input }) => engine.scratchAgendaAdd(input)),
    scratchAgendaComplete: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.scratchAgendaComplete.input, value))
      .output(engineSchemas.scratchAgendaComplete.output)
      .mutation(({ input }) => engine.scratchAgendaComplete(input)),
    scratchAgendaSupersede: procedure
      .input((value: unknown) =>
        parseEngineInput(engineSchemas.scratchAgendaSupersede.input, value),
      )
      .output(engineSchemas.scratchAgendaSupersede.output)
      .mutation(({ input }) => engine.scratchAgendaSupersede(input)),
    scratchCheckpoint: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.scratchCheckpoint.input, value))
      .output(engineSchemas.scratchCheckpoint.output)
      .mutation(({ input }) => engine.scratchCheckpoint(input)),
    scratchCreate: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.scratchCreate.input, value))
      .output(engineSchemas.scratchCreate.output)
      .mutation(({ input }) => engine.scratchCreate(input)),
    scratchDiscard: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.scratchDiscard.input, value))
      .output(engineSchemas.scratchDiscard.output)
      .mutation(({ input }) => engine.scratchDiscard(input)),
    scratchFreeze: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.scratchFreeze.input, value))
      .output(engineSchemas.scratchFreeze.output)
      .mutation(({ input }) => engine.scratchFreeze(input)),
    scratchGet: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.scratchGet.input, value))
      .output(engineSchemas.scratchGet.output)
      .query(({ input }) => engine.scratchGet(input)),
    scratchList: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.scratchList.input, value))
      .output(engineSchemas.scratchList.output)
      .query(({ input }) => engine.scratchList(input)),
    scratchUpdate: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.scratchUpdate.input, value))
      .output(engineSchemas.scratchUpdate.output)
      .mutation(({ input }) => engine.scratchUpdate(input)),
    search: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.search.input, value))
      .output(engineSchemas.search.output)
      .query(({ input }) => engine.search(input)),
    seedCreate: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.seedCreate.input, value))
      .output(engineSchemas.seedCreate.output)
      .mutation(({ input }) => engine.seedCreate(input)),
    seedPark: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.seedPark.input, value))
      .output(engineSchemas.seedPark.output)
      .mutation(({ input }) => engine.seedPark(input)),
    seedPromote: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.seedPromote.input, value))
      .output(engineSchemas.seedPromote.output)
      .mutation(({ input }) => engine.seedPromote(input)),
    seedReject: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.seedReject.input, value))
      .output(engineSchemas.seedReject.output)
      .mutation(({ input }) => engine.seedReject(input)),
    seedResolve: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.seedResolve.input, value))
      .output(engineSchemas.seedResolve.output)
      .mutation(({ input }) => engine.seedResolve(input)),
    seedUnpark: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.seedUnpark.input, value))
      .output(engineSchemas.seedUnpark.output)
      .mutation(({ input }) => engine.seedUnpark(input)),
    seedUpdate: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.seedUpdate.input, value))
      .output(engineSchemas.seedUpdate.output)
      .mutation(({ input }) => engine.seedUpdate(input)),
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
    triage: procedure
      .input((value: unknown) => parseEngineInput(engineSchemas.triage.input, value))
      .output(engineSchemas.triage.output)
      .mutation(({ input }) => engine.triage(input)),
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
export function createEngineHandler(
  engine: Engine,
  options: { version: string; endpoint?: string },
) {
  if (!parse(options.version)) {
    throw new Error(`invalid host version: ${options.version}`);
  }
  const router = createEngineRouter(engine);
  return async (req: Request) => {
    const context = {
      clientVersion: req.headers.get('x-mimir-version'),
      hostVersion: options.version,
    };
    const refusal = versionRefusal(context);
    // Removed or re-kinded procedures must receive the remedy before tRPC resolves them.
    if (refusal) {
      const error = new TRPCError({
        cause: refusal,
        code: domainCodes[refusal.code],
        message: refusal.message,
      });
      const shape = getTRPCErrorShape({
        config: t._config,
        ctx: context,
        error,
        input: undefined,
        path: undefined,
        type: 'unknown',
      });
      const result = { error: shape };
      const url = new URL(req.url);
      const body =
        url.searchParams.get('batch') === '1'
          ? url.pathname.split(/,|%2c/i).map(() => result)
          : result;
      return Response.json(transformTRPCResponse(t._config, body), {
        status: shape.data.httpStatus,
      });
    }
    return fetchRequestHandler({
      createContext: () => context,
      endpoint: options.endpoint ?? '/trpc',
      onError({ error }) {
        if (error.code === 'INTERNAL_SERVER_ERROR' && !(error.cause instanceof MimirError)) {
          const diagnostic = formatDiagnostic({
            ...describeFault(error.cause ?? error),
            method: req.method,
            path: new URL(req.url).pathname,
          });
          console.error(`✗ host: request did not complete — ${diagnostic}`);
        }
      },
      req,
      router,
    });
  };
}
