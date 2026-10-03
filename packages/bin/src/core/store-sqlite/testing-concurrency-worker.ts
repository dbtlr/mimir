/**
 * One writer process in the SQLite two-process concurrency proof (ADR 0032
 * Decision 3) — the local tier's counterpart of the Postgres worker beside
 * `core/store-postgres`, which explains the shape.
 *
 * Two handles in one process share the driver's mutex and the event loop, so
 * only separate processes contend on the database's own write lock — the
 * arrangement of the CLI writing while `mimir serve` runs.
 *
 *   create <phase stem>  allocate an identity: a task under that phase.
 *   patch  <node stem>   read-modify-write that node: append an annotation and
 *                        increment its rank, in one transaction.
 *
 * The caller asserts the outcome. Not a test file itself — the test spawns it
 * by path.
 */
import { createTask } from '../create';
import { now } from '../time';
import { openSqlite } from './client';
import { createSqliteStore } from './dialect';

const USAGE = 'usage: testing-concurrency-worker <path> <create|patch> <stem> <label> <count>';

const [path, kind, stem, label, count] = process.argv.slice(2);
if (
  path === undefined ||
  stem === undefined ||
  label === undefined ||
  count === undefined ||
  !(kind === 'create' || kind === 'patch')
) {
  throw new Error(USAGE);
}

const handle = await openSqlite(path);
try {
  const store = createSqliteStore(handle.db);
  for (let i = 0; i < Number(count); i++) {
    if (kind === 'create') {
      await createTask(store, { parentId: stem, title: `${label}-${String(i)}` });
      continue;
    }
    await store.transact(async (writer) => {
      const node = await writer.loadNode(stem);
      if (node === undefined) {
        throw new Error(`${stem} vanished`);
      }
      const stamp = now();
      await writer.insertAnnotation({
        content: `${label}-${String(i)}`,
        created_at: stamp,
        node_id: stem,
      });
      // The read above and this write share one immediate transaction, so the
      // other process's increment waits on the write lock rather than reading
      // the same rank.
      await writer.updateNode(stem, { rank: (node.rank ?? 0) + 1, updated_at: stamp });
    });
  }
} finally {
  await handle.close();
}
