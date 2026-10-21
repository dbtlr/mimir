/**
 * What `mimir-host` commands act through: the host's credential store, its
 * record-health facet, and its transfer document. Host administration stays
 * off the Engine (ADR 0038), so none of these is an Engine method; `app.ts`
 * opens the host's store once and hands commands only these.
 */
import type { StoreTransfer } from '@mimir/cli/src/machine';
import type { DoctorFacet, TokenStore } from '@mimir/core';

export type AdminPorts = {
  /** Pairing requests and device tokens, from the store opened on first ask. */
  tokens: () => Promise<TokenStore>;
  /** The record-health facet the console reads, narrowed to `scope` when given. */
  doctor: (scope: string | undefined) => Promise<DoctorFacet>;
  /** The host store's transfer document. */
  transfer: StoreTransfer;
  /** The current instant, which ages are read from. */
  now: () => Date;
};
