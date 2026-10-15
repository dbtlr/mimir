import {
  engineNodeFromViewSchema,
  engineSchemas,
  parseEngineInput,
  WRITE_ECHO_FACETS,
} from '@mimir/contract';
import type { Engine } from '@mimir/contract';

import { getNode, nodeViewOf } from './intent';
import { completeTask } from './mutations';
import type { Store } from './store';

/** The store-owning Engine; transports use the same methods locally or remotely. */
export class LocalEngine implements Engine {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  async getNode(input: Parameters<Engine['getNode']>[0]) {
    const { id, facets } = parseEngineInput(engineSchemas.getNode.input, input);
    return engineNodeFromViewSchema.parse(await getNode(this.store, id, { facets }));
  }

  async done(input: Parameters<Engine['done']>[0]) {
    const { id } = parseEngineInput(engineSchemas.done.input, input);
    const node = await completeTask(this.store, id);
    return engineNodeFromViewSchema.parse(
      await nodeViewOf(this.store, node, new Set(WRITE_ECHO_FACETS)),
    );
  }
}
