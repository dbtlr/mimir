/**
 * The self-update output layer (MMR-59). The structured `json` / `jsonl`
 * envelope is a versioned promise (snake_case wire names, never styled), kept
 * separate from the camelCase result the command layer computes.
 */
import { emitWire } from '@mimir/core';

export type SelfUpdateResult = {
  from: string;
  to: string;
  updated: boolean;
  asset: string;
};

export function formatSelfUpdateJson(result: SelfUpdateResult, pretty: boolean): string {
  return emitWire(
    {
      asset: result.asset,
      from: result.from,
      to: result.to,
      updated: result.updated,
    },
    pretty,
  );
}
