import type { DeliveryView, EngineInput } from '@mimir/contract';

/** Project-anchored attempts, independent of the work tree. */
export type DeliveryStore = {
  create: (input: EngineInput<'deliveryCreate'>) => Promise<DeliveryView>;
  get: (id: string) => Promise<DeliveryView>;
  list: (project: string) => Promise<DeliveryView[]>;
  update: (input: EngineInput<'deliveryUpdate'>) => Promise<DeliveryView>;
};
