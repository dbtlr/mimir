import { mimirErrorSchema, MimirError, UNIFORM_VERBS } from '@mimir/contract';
import type { Engine, EngineInput, UniformVerb } from '@mimir/contract';
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

  constructor(options: RemoteEngineOptions) {
    super();
    this.client = createTRPCClient<EngineRouter>({
      links: [httpLink({ ...options, transformer: superjson })],
    });
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
}

function isMutation(value: unknown): value is { mutate: (input: unknown) => Promise<unknown> } {
  // tRPC's client is a proxy, so a procedure is a function whose `mutate` is read, not listed.
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof Reflect.get(value, 'mutate') === 'function'
  );
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
