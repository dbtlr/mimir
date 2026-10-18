import { mimirErrorSchema, MimirError, UNIFORM_VERBS } from '@mimir/contract';
import type {
  ConsoleEngine,
  ConsoleInput,
  Engine,
  EngineInput,
  UniformVerb,
} from '@mimir/contract';
import { createTRPCClient, httpLink, TRPCClientError } from '@trpc/client';
import type { TRPCClient } from '@trpc/client';
import superjson from 'superjson';

import type { EngineRouter } from './server';

type RemoteEngineOptions = {
  url: string;
  fetch?: Parameters<typeof httpLink<EngineRouter>>[0]['fetch'];
};

/** The client a uniform-verb method calls through, read from the Engine that extends the base. */
class UniformVerbMethods {
  declare protected readonly client: object;
}
for (const verb of UNIFORM_VERBS) {
  Object.defineProperty(UniformVerbMethods.prototype, verb, {
    // Writable and configurable, like a class method.
    configurable: true,
    value(this: UniformVerbMethods, input: unknown) {
      const procedure: unknown = Reflect.get(this.client, verb);
      if (!isMutation(procedure)) {
        throw new Error(`the client has no ${verb} procedure`);
      }
      return domainResult(procedure.mutate(input));
    },
    writable: true,
  });
}

/**
 * The twelve uniform verbs as Engine methods, derived from the contract's
 * operation facts (ADR 0025) rather than written out.
 */
// The loop above installs exactly the UNIFORM_VERBS methods this type names.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const UniformEngineBase = UniformVerbMethods as unknown as abstract new () => Pick<
  Engine,
  UniformVerb
>;

/** A store-free Engine; only the client entry and contract are runtime dependencies. */
export class RemoteEngine extends UniformEngineBase implements Engine {
  protected readonly client: TRPCClient<EngineRouter>;
  readonly console: ConsoleEngine;

  constructor(options: RemoteEngineOptions) {
    super();
    this.client = createTRPCClient<EngineRouter>({
      links: [httpLink({ ...options, transformer: superjson })],
    });
    this.console = consoleBindings(this.client);
  }

  artifacts(input: EngineInput<'artifacts'>) {
    return domainResult(this.client.artifacts.query(input));
  }

  getArtifact(input: EngineInput<'getArtifact'>) {
    return domainResult(this.client.getArtifact.query(input));
  }

  getNode(input: EngineInput<'getNode'>) {
    return domainResult(this.client.getNode.query(input));
  }

  getSeed(input: EngineInput<'getSeed'>) {
    return domainResult(this.client.getSeed.query(input));
  }

  list(input: EngineInput<'list'>) {
    return domainResult(this.client.list.query(input));
  }

  next(input: EngineInput<'next'>) {
    return domainResult(this.client.next.query(input));
  }

  overview(input: EngineInput<'overview'>) {
    return domainResult(this.client.overview.query(input));
  }

  projects(input: EngineInput<'projects'>) {
    return domainResult(this.client.projects.query(input));
  }

  projectsByRemote(input: EngineInput<'projectsByRemote'>) {
    return domainResult(this.client.projectsByRemote.query(input));
  }

  scratchGet(input: EngineInput<'scratchGet'>) {
    return domainResult(this.client.scratchGet.query(input));
  }

  scratchList(input: EngineInput<'scratchList'>) {
    return domainResult(this.client.scratchList.query(input));
  }

  search(input: EngineInput<'search'>) {
    return domainResult(this.client.search.query(input));
  }

  seeds(input: EngineInput<'seeds'>) {
    return domainResult(this.client.seeds.query(input));
  }

  status(input: EngineInput<'status'>) {
    return domainResult(this.client.status.query(input));
  }

  tree(input: EngineInput<'tree'>) {
    return domainResult(this.client.tree.query(input));
  }

  annotate(input: EngineInput<'annotate'>) {
    return domainResult(this.client.annotate.mutate(input));
  }

  attach(input: EngineInput<'attach'>) {
    return domainResult(this.client.attach.mutate(input));
  }

  create(input: EngineInput<'create'>) {
    return domainResult(this.client.create.mutate(input));
  }

  depend(input: EngineInput<'depend'>) {
    return domainResult(this.client.depend.mutate(input));
  }

  groom(input: EngineInput<'groom'>) {
    return domainResult(this.client.groom.mutate(input));
  }

  move(input: EngineInput<'move'>) {
    return domainResult(this.client.move.mutate(input));
  }

  reorder(input: EngineInput<'reorder'>) {
    return domainResult(this.client.reorder.mutate(input));
  }

  tag(input: EngineInput<'tag'>) {
    return domainResult(this.client.tag.mutate(input));
  }

  undepend(input: EngineInput<'undepend'>) {
    return domainResult(this.client.undepend.mutate(input));
  }

  untag(input: EngineInput<'untag'>) {
    return domainResult(this.client.untag.mutate(input));
  }

  update(input: EngineInput<'update'>) {
    return domainResult(this.client.update.mutate(input));
  }

  updateProject(input: EngineInput<'updateProject'>) {
    return domainResult(this.client.updateProject.mutate(input));
  }

  scratchAgendaAdd(input: EngineInput<'scratchAgendaAdd'>) {
    return domainResult(this.client.scratchAgendaAdd.mutate(input));
  }

  scratchAgendaComplete(input: EngineInput<'scratchAgendaComplete'>) {
    return domainResult(this.client.scratchAgendaComplete.mutate(input));
  }

  scratchAgendaSupersede(input: EngineInput<'scratchAgendaSupersede'>) {
    return domainResult(this.client.scratchAgendaSupersede.mutate(input));
  }

  scratchCheckpoint(input: EngineInput<'scratchCheckpoint'>) {
    return domainResult(this.client.scratchCheckpoint.mutate(input));
  }

  scratchCreate(input: EngineInput<'scratchCreate'>) {
    return domainResult(this.client.scratchCreate.mutate(input));
  }

  scratchDiscard(input: EngineInput<'scratchDiscard'>) {
    return domainResult(this.client.scratchDiscard.mutate(input));
  }

  scratchFreeze(input: EngineInput<'scratchFreeze'>) {
    return domainResult(this.client.scratchFreeze.mutate(input));
  }

  scratchUpdate(input: EngineInput<'scratchUpdate'>) {
    return domainResult(this.client.scratchUpdate.mutate(input));
  }

  seedCreate(input: EngineInput<'seedCreate'>) {
    return domainResult(this.client.seedCreate.mutate(input));
  }

  seedPark(input: EngineInput<'seedPark'>) {
    return domainResult(this.client.seedPark.mutate(input));
  }

  seedPromote(input: EngineInput<'seedPromote'>) {
    return domainResult(this.client.seedPromote.mutate(input));
  }

  seedReject(input: EngineInput<'seedReject'>) {
    return domainResult(this.client.seedReject.mutate(input));
  }

  seedResolve(input: EngineInput<'seedResolve'>) {
    return domainResult(this.client.seedResolve.mutate(input));
  }

  seedUnpark(input: EngineInput<'seedUnpark'>) {
    return domainResult(this.client.seedUnpark.mutate(input));
  }

  seedUpdate(input: EngineInput<'seedUpdate'>) {
    return domainResult(this.client.seedUpdate.mutate(input));
  }

  triage(input: EngineInput<'triage'>) {
    return domainResult(this.client.triage.mutate(input));
  }
}

function isMutation(value: unknown): value is { mutate: (input: unknown) => Promise<unknown> } {
  // tRPC's client is a proxy, so a procedure is a function whose `mutate` is read, not listed.
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof Reflect.get(value, 'mutate') === 'function'
  );
}

/** The console namespace's bindings, one query procedure per method. */
function consoleBindings(client: TRPCClient<EngineRouter>): ConsoleEngine {
  return {
    nodeWork: (input: ConsoleInput<'nodeWork'>) =>
      domainResult(client.console.nodeWork.query(input)),
    overview: (input: ConsoleInput<'overview'>) =>
      domainResult(client.console.overview.query(input)),
    projectWork: (input: ConsoleInput<'projectWork'>) =>
      domainResult(client.console.projectWork.query(input)),
    review: (input: ConsoleInput<'review'>) => domainResult(client.console.review.query(input)),
    search: (input: ConsoleInput<'search'>) => domainResult(client.console.search.query(input)),
  };
}

/** Reconstruct domain refusals; network and protocol failures keep their transport identity. */
async function domainResult<T>(result: Promise<T>): Promise<T> {
  try {
    return await result;
  } catch (error) {
    if (error instanceof TRPCClientError) {
      const parsed = mimirErrorSchema.safeParse(error.data?.mimirError);
      if (parsed.success) {
        throw new MimirError(parsed.data.code, parsed.data.message, parsed.data.hint);
      }
    }
    throw error;
  }
}
