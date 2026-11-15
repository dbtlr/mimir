import type { DecisionHistory, DecisionView, EngineInput } from '@mimir/contract';

import { assertBoardActive } from '../archive-lock';
import { isTerminalDelivery } from '../deliveries/store';
import { notFound, validation } from '../errors';
import { parseDeliveryRef, renderDeliveryRef, parseIdentity, renderDecisionRef } from '../ids';
import { stamp } from '../mutations/common';
import type { Store, StoreWriter } from '../store';
import { now } from '../time';

const prose = (s: string | undefined): string | null =>
  s === undefined || s.trim() === '' ? null : s;
function ref(id: string): string {
  const parsed = parseIdentity(id);
  if (parsed?.kind !== 'decision') {
    throw validation(`${id} is not a decision`, 'use a KEY-qN id');
  }
  return renderDecisionRef(parsed);
}
async function deliveryOf(w: StoreWriter, id: string, key?: string) {
  const parsed = parseDeliveryRef(id);
  const delivery = parsed ? await w.loadDelivery(renderDeliveryRef(parsed)) : undefined;
  if (!delivery || (key !== undefined && key !== delivery.key)) {
    throw validation(
      `${id} must name a delivery in the same project`,
      'pass a same-project --delivery',
    );
  }
  if (isTerminalDelivery(delivery.lifecycle)) {
    throw validation(`${id} is terminal`, 'pass a nonterminal --delivery');
  }
  return { ...delivery, id: parsed ? renderDeliveryRef(parsed) : id };
}
async function tasksOf(w: StoreWriter, ids: string[], key: string): Promise<string[]> {
  if (new Set(ids).size !== ids.length) {
    throw validation('a task is named twice', 'name each --task or --untask once');
  }
  const tasks = [];
  for (const id of ids) {
    const task = await w.loadNode(id);
    if (!task || task.type !== 'task' || task.project_id !== key) {
      throw validation(`${id} must name a task in ${key}`, 'pass a task in the decision project');
    }
    tasks.push(task);
  }
  return tasks.toSorted((a, b) => a.seq - b.seq).map((t) => t.id);
}
function log(
  kind: DecisionHistory['kind'],
  from_value: string | null,
  to_value: string | null,
  task: string | null = null,
  reason: string | null = null,
): DecisionHistory {
  return { at: now(), from_value, kind, reason, task, to_value };
}
export function decide(store: Store, input: EngineInput<'decide'>): Promise<DecisionView> {
  return store.decisions.create(async (w) => {
    if (input.question.trim() === '') {
      throw validation('a decision requires a nonblank question', 'pass a question');
    }
    if (input.options.length < 2) {
      throw validation('a decision requires at least two options', 'add another --option');
    }
    if (input.options.some((s) => s.trim() === '')) {
      throw validation('an option is blank', 'pass nonblank --option text');
    }
    const taken = input.taken ?? input.recommended;
    for (const n of [taken, input.recommended]) {
      if (n < 1 || n > input.options.length) {
        throw validation('option number is out of range', 'name a listed option');
      }
    }
    const delivery =
      input.delivery === undefined ? undefined : await deliveryOf(w, input.delivery, input.project);
    const key = delivery?.key ?? input.project;
    if (!key) {
      throw validation('a decision requires a project', 'pass --project KEY or --delivery KEY-dN');
    }
    assertBoardActive(await w.loadProject(key), key);
    const tasks = await tasksOf(w, input.tasks ?? [], key);
    const history = tasks.map((task) => log('link', null, 'linked', task));
    if (input.delivery) {
      history.push(log('delivery', null, delivery?.id ?? input.delivery));
    }
    const at = now();
    return {
      class: input.class,
      created_at: at,
      delivery: delivery?.id ?? null,
      history,
      lifecycle: 'provisional',
      options: input.options,
      outcome_note: null,
      overturn_option: null,
      project_key: key,
      question: input.question,
      recommended: input.recommended,
      taken,
      tasks,
      updated_at: at,
      why: prose(input.why),
    };
  });
}
export async function getDecision(store: Store, id: string): Promise<DecisionView> {
  const value = await store.decisions.load(ref(id));
  const project =
    value &&
    (await store.loadProjects()).find((p) => p.key === value.project_key && p.archived_at === null);
  if (!value || !project) {
    throw notFound(`${id} doesn't exist`);
  }
  return value;
}
export function updateDecision(
  store: Store,
  input: EngineInput<'decisionUpdate'>,
): Promise<DecisionView> {
  return store.decisions.transact(ref(input.id), async (d, w) => {
    if (
      (input.tasks?.length ?? 0) === 0 &&
      (input.untasks?.length ?? 0) === 0 &&
      input.delivery === undefined
    ) {
      throw validation('empty decision update', 'pass --task, --untask, or --delivery');
    }
    const add = await tasksOf(w, input.tasks ?? [], d.project_key);
    const remove = await tasksOf(w, input.untasks ?? [], d.project_key);
    if (add.some((id) => remove.includes(id))) {
      throw validation('task named under both --task and --untask', 'name each task once');
    }
    for (const id of add) {
      if (d.tasks.includes(id)) {
        throw validation(`${id} is already linked`, 'omit --task or use --untask');
      }
    }
    for (const id of remove) {
      if (!d.tasks.includes(id)) {
        throw validation(`${id} is not linked`, 'omit --untask or use --task');
      }
    }
    const delivery =
      input.delivery == null
        ? input.delivery
        : (await deliveryOf(w, input.delivery, d.project_key)).id;
    if (delivery !== undefined) {
      if (delivery === d.delivery) {
        throw validation('delivery is already set to that value', 'pass a different --delivery');
      }
    }
    for (const id of remove) {
      d.history.push(log('link', null, 'unlinked', id));
    }
    for (const id of add) {
      d.history.push(log('link', null, 'linked', id));
    }
    d.tasks = await tasksOf(
      w,
      [...d.tasks.filter((id) => !remove.includes(id)), ...add],
      d.project_key,
    );
    if (input.delivery !== undefined) {
      d.history.push(log('delivery', d.delivery, delivery ?? null));
      d.delivery = delivery ?? null;
    }
    d.updated_at = now();
    return d;
  });
}
export function answerDecision(
  store: Store,
  verb: 'confirm' | 'overturn',
  input: { id: string; note?: string; option?: number },
): Promise<DecisionView> {
  return store.decisions.transact(ref(input.id), async (d, w) => {
    const note = prose(input.note);
    if (verb === 'overturn') {
      if (input.option === undefined && note === null) {
        throw validation('overturn requires an answer', 'pass --option N or a note');
      }
      if (input.option !== undefined && (input.option < 1 || input.option > d.options.length)) {
        throw validation('option is out of range', 'name a listed option');
      }
      if (input.option === d.taken) {
        throw validation('that is the answer taken', 'use confirm for the answer taken');
      }
      const answer =
        input.option === undefined
          ? note
          : `option ${String(input.option)} (${d.options[input.option - 1] ?? ''})${note === null ? '' : `: ${note}`}`;
      for (const task of d.tasks) {
        await w.insertAnnotation({
          content: `decision ${d.id} overturned: ${answer ?? ''}`,
          created_at: now(),
          node_id: task,
        });
        await stamp(w, task);
      }
    }
    d.lifecycle = verb === 'confirm' ? 'confirmed' : 'overturned';
    d.outcome_note = note;
    d.overturn_option = input.option ?? null;
    d.history.push(log('lifecycle', 'provisional', d.lifecycle, null, note));
    d.updated_at = now();
    return d;
  });
}
