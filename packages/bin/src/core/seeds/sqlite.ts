import { validation } from '../errors';
import type { SeedStore } from './store';

/**
 * The SQLite `SeedStore` arm (MMR-244): a hard stub. Seeds are a Norn-only
 * entity — the SQLite backend is a fenced rollback being retired (MMR-234) and
 * never grows a seed table. Every method throws a clear error rather than
 * silently no-oping, so a misconfigured composition root fails loud instead of
 * dropping seed state on the floor. The `Store.seeds` seam still requires an
 * implementation on both backends; this satisfies the type while refusing use.
 */
const refuse = (): never => {
  throw validation(
    'seeds require the norn backend',
    'the SQLite backend does not store seeds (MMR-234); run against the vault',
  );
};

export function createSqliteSeedStore(): SeedStore {
  return {
    appendSpawned: () => refuse(),
    create: () => refuse(),
    listForProject: () => refuse(),
    load: () => refuse(),
    patch: () => refuse(),
    transition: () => refuse(),
  };
}
