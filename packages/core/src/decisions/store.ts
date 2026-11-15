import type { DecisionView } from '@mimir/contract';

import type { StoreWriter } from '../store';

export type DecisionStore = {
  create: (
    prepare: (writer: StoreWriter) => Promise<Omit<DecisionView, 'id' | 'seq'>>,
  ) => Promise<DecisionView>;
  transact: (
    id: string,
    apply: (decision: DecisionView, writer: StoreWriter) => Promise<DecisionView>,
  ) => Promise<DecisionView>;
  load: (id: string) => Promise<DecisionView | undefined>;
  forTask: (id: string) => Promise<Pick<DecisionView, 'id' | 'lifecycle'>[]>;
};
