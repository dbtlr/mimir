/**
 * One writer process in the two-process concurrency proof (ADR 0030 Decision 2).
 *
 * Two pools inside one process share a JavaScript event loop and can interleave
 * only where they await, so an in-process race proves far less than it looks
 * like it does. This script is spawned twice against the same database, so the
 * two writers are genuinely concurrent operating-system processes that share
 * nothing but Postgres — which is the arrangement the shared store exists for.
 *
 * One run does one kind of work `count` times, as fast as it can:
 *
 *   create <phase stem>  allocate an identity: a task under that phase.
 *   patch  <node stem>   read-modify-write that node: append an annotation and
 *                        increment its rank, in one transaction.
 *
 * One kind per run, because the caller races two workers doing the SAME work.
 * Mixing them would measure a hot spot rather than a race: a create reads every
 * ranked task in the project, so it conflicts with a patch on any one of them,
 * and two processes interleaving the two kinds stay in conflict long enough to
 * exhaust a bounded retry budget. That budget is not what is under proof here;
 * losing nothing is.
 *
 * The caller asserts the outcome. Not a test file itself — the integration lane
 * invokes it by path.
 */
import { createTask } from '../create';
import { now } from '../time';
import { openPostgres } from './client';
import { createPostgresStore } from './store';

const USAGE = 'usage: testing-concurrency-worker <url> <create|patch> <stem> <label> <count>';

const [url, kind, stem, label, count] = process.argv.slice(2);
if (
  url === undefined ||
  stem === undefined ||
  label === undefined ||
  count === undefined ||
  !(kind === 'create' || kind === 'patch')
) {
  throw new Error(USAGE);
}

const handle = openPostgres(url);
try {
  const store = createPostgresStore(handle.db);
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
      // The read above and this write are one serializable transaction, so a
      // concurrent increment either serializes behind it or loses and replays.
      await writer.updateNode(stem, { rank: (node.rank ?? 0) + 1, updated_at: stamp });
    });
  }
} finally {
  await handle.close();
}
