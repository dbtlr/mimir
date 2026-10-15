import { mimirErrorSchema, MimirError } from '@mimir/contract';
import type { Engine } from '@mimir/contract';
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

  getNode(input: Parameters<Engine['getNode']>[0]) {
    return domainResult(this.client.getNode.query(input));
  }

  done(input: Parameters<Engine['done']>[0]) {
    return domainResult(this.client.done.mutate(input));
  }
}

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
