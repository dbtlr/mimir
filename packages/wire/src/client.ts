import { mimirErrorSchema, MimirError } from '@mimir/contract';
import type { Engine, EngineInput } from '@mimir/contract';
import { createTRPCClient, httpLink, TRPCClientError } from '@trpc/client';
import type { TRPCClient } from '@trpc/client';
import superjson from 'superjson';

import type { EngineRouter } from './server';

type RemoteEngineOptions = {
  url: string;
  fetch?: Parameters<typeof httpLink<EngineRouter>>[0]['fetch'];
};

/** A store-free Engine; only the client entry and contract are runtime dependencies. */
export class RemoteEngine implements Engine {
  private readonly client: TRPCClient<EngineRouter>;

  constructor(options: RemoteEngineOptions) {
    this.client = createTRPCClient<EngineRouter>({
      links: [httpLink({ ...options, transformer: superjson })],
    });
  }

  artifacts(input: EngineInput<'artifacts'>) {
    return domainResult(this.client.artifacts.query(input));
  }

  done(input: EngineInput<'done'>) {
    return domainResult(this.client.done.mutate(input));
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
