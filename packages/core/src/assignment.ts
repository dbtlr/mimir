import type { Node } from './model';

/** A session identifies the same agent unless two known harness providers explicitly differ. */
export function hasRedundantWorker(
  identity: Pick<Node, 'harness' | 'session' | 'worker_harness' | 'worker_session'>,
): boolean {
  const mainProvider = identity.harness?.replace(/\s+/g, ' ').trim() ?? '';
  const workerProvider = identity.worker_harness?.replace(/\s+/g, ' ').trim() ?? '';
  return (
    identity.worker_session !== null &&
    identity.worker_session === identity.session &&
    (mainProvider === '' || workerProvider === '' || mainProvider === workerProvider)
  );
}
