import type { DecisionView, EngineInput } from '@mimir/contract';

import type { StoreWriter } from '../store';

export type DecisionStore = {
  create: (
    prepare: (writer: StoreWriter) => Promise<Omit<DecisionView, 'id' | 'seq'>>,
  ) => Promise<DecisionView>;
  transact: (
    id: string,
    apply: (decision: DecisionView, writer: StoreWriter) => Promise<DecisionView>,
  ) => Promise<DecisionView>;
  /** Provisional decisions in active projects, with task links and no history. */
  listProvisional: () => Promise<DecisionView[]>;
  list: (input: EngineInput<'decisions'>) => Promise<DecisionView[]>;
  countProvisional: (project: string) => Promise<number>;
  load: (id: string) => Promise<DecisionView | undefined>;
  forTask: (id: string) => Promise<Pick<DecisionView, 'id' | 'lifecycle'>[]>;
};
