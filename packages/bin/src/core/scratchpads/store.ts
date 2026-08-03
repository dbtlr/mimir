import type { Scratchpad } from '@mimir/contract';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Scratchpads use canonical lowercase UUIDv4 handles, never Mimir sequence ids. */
export function isScratchpadId(value: string): boolean {
  return UUID_V4.test(value);
}

export type ScratchpadStore = {
  create: (scratchpad: Scratchpad) => Promise<void>;
  load: (id: string) => Promise<Scratchpad | undefined>;
  list: (project?: string) => Promise<Scratchpad[]>;
  replace: (scratchpad: Scratchpad, expectedUpdatedAt: string) => Promise<void>;
  delete: (id: string, expectedUpdatedAt: string) => Promise<void>;
};
