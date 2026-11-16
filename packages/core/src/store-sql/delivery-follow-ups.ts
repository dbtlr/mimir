import { notFound, validation } from '../errors';
import { parseIdentity } from '../ids';
import { identityNoun } from '../project-only';
import type { Executor } from './schema';
import { toRowId } from './schema';

const canonical = (id: string): string => {
  const ref = parseIdentity(id);
  if (ref?.kind === 'node') {
    return `${ref.key}-${String(ref.seq)}`;
  }
  if (ref?.kind === 'seed') {
    return `${ref.key}-s${String(ref.seq)}`;
  }
  return id;
};

/** Visible rows only: archive hides both standing links and their events. */
export async function visibleFollowUps(ex: Executor, delivery: string) {
  const rows = await ex
    .selectFrom('delivery_follow_up as link')
    .leftJoin('node', 'node.id', 'link.task')
    .leftJoin('seed', 'seed.id', 'link.seed')
    .innerJoin('project', (join) =>
      join.on((eb) =>
        eb.or([
          eb('project.key', '=', eb.ref('node.project_key')),
          eb('project.key', '=', eb.ref('seed.project_key')),
        ]),
      ),
    )
    .select(['link.id', 'link.task', 'link.seed', 'link.linked_at', 'link.unlinked_at'])
    .where('link.delivery_id', '=', delivery)
    .where('project.archived_at', 'is', null)
    .orderBy('link.id')
    .execute();
  return rows.flatMap((row) => {
    const record = row.task ?? row.seed;
    return record === null ? [] : [{ ...row, id: toRowId(row.id), record }];
  });
}

/** Validate in the contract's numbered order, then unlink and link in caller order. */
export async function writeFollowUps(
  ex: Executor,
  delivery: string,
  project: string,
  links: { follow: readonly string[]; unfollow: readonly string[] },
  at: string,
) {
  const ids = [...links.unfollow, ...links.follow];
  if (new Set(ids.map(canonical)).size !== ids.length) {
    throw validation('a follow-up id occurs more than once');
  }
  const refs = ids.map((id) => {
    const ref = parseIdentity(id);
    if (!ref) {
      throw notFound(`${id} doesn't exist`);
    }
    if (ref.kind !== 'node' && ref.kind !== 'seed') {
      throw validation(`${id} is ${identityNoun(ref.kind)}, not a task or seed`);
    }
    return { id: canonical(id), key: ref.key, kind: ref.kind, seq: ref.seq };
  });
  const records = [];
  for (const ref of refs) {
    const board = await ex
      .selectFrom('project')
      .select('archived_at')
      .where('key', '=', ref.key)
      .executeTakeFirst();
    const record =
      ref.kind === 'node'
        ? await ex
            .selectFrom('node')
            .select(['type', 'project_key'])
            .where('id', '=', ref.id)
            .executeTakeFirst()
        : await ex
            .selectFrom('seed')
            .select('project_key')
            .where('id', '=', ref.id)
            .executeTakeFirst();
    if (!board || board.archived_at !== null || !record) {
      throw notFound(`${ref.id} doesn't exist`);
    }
    records.push({ ...ref, record });
  }
  for (const { id, record } of records) {
    if ('type' in record && record.type !== 'task') {
      throw validation(`${id} is a ${String(record.type)}, not a task`);
    }
  }
  for (const { id, kind, key } of records) {
    if (kind === 'node' && key !== project) {
      throw validation(`${id} is in another project than ${delivery}`);
    }
  }
  const standing = await ex
    .selectFrom('delivery_follow_up')
    .selectAll()
    .where('delivery_id', '=', delivery)
    .where('unlinked_at', 'is', null)
    .execute();
  for (const [index, ref] of records.entries()) {
    const row = standing.find((candidate) => (candidate.task ?? candidate.seed) === ref.id);
    const unlink = index < links.unfollow.length;
    if (unlink ? !row : row) {
      throw validation(`${ref.id} is ${unlink ? 'not linked' : 'already linked'} to ${delivery}`);
    }
  }
  for (const ref of records.slice(0, links.unfollow.length)) {
    const row = standing.find((candidate) => (candidate.task ?? candidate.seed) === ref.id);
    if (row) {
      await ex
        .updateTable('delivery_follow_up')
        .set({ unlinked_at: at < row.linked_at ? row.linked_at : at })
        .where('id', '=', row.id)
        .execute();
    }
  }
  for (const ref of records.slice(links.unfollow.length)) {
    await ex
      .insertInto('delivery_follow_up')
      .values({
        delivery_id: delivery,
        linked_at: at,
        seed: ref.kind === 'seed' ? ref.id : null,
        task: ref.kind === 'node' ? ref.id : null,
        unlinked_at: null,
      })
      .execute();
  }
}
