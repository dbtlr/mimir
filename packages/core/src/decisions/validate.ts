import { decisionViewSchema } from '@mimir/contract';

import type { StoreExport } from '../export';
import { renderDecisionRef } from '../ids';
import { isCanonicalInstant } from '../time';

/** Cross-record and history invariants shared by import and doctor. */
export function decisionFaults(document: {
  decisions: StoreExport['decisions'];
  projects: readonly { key: string; counters: { decision: number } }[];
  nodes: readonly Pick<StoreExport['nodes'][number], 'id' | 'type' | 'project_id'>[];
  deliveries: readonly Pick<StoreExport['deliveries'][number], 'id' | 'project_key'>[];
}): { id: string; message: string }[] {
  const faults: { id: string; message: string }[] = [];
  const projects = new Map(document.projects.map((p) => [p.key, p]));
  const nodes = new Map(document.nodes.map((n) => [n.id, n]));
  const deliveries = new Map(document.deliveries.map((d) => [d.id, d]));
  const ids = new Set<string>();
  for (const d of document.decisions) {
    const fail = (message: string) => {
      faults.push({ id: d.id, message });
    };
    if (!decisionViewSchema.safeParse(d).success) {
      fail('invalid decision shape or closed value');
      continue;
    }
    if (ids.has(d.id)) {
      fail('duplicate decision identity');
    }
    ids.add(d.id);
    if (d.id !== renderDecisionRef({ key: d.project_key, seq: d.seq })) {
      fail('identity disagrees with project or seq');
    }
    if (!projects.has(d.project_key)) {
      fail('missing decision project');
    } else if (d.seq > (projects.get(d.project_key)?.counters.decision ?? 0)) {
      fail('sequence exceeds project counter');
    }
    if (!d.question.trim() || d.options.length < 2 || d.options.some((s) => !s.trim())) {
      fail('requires a question and at least two nonblank options');
    }
    if (
      !['product', 'architecture', 'other'].includes(d.class) ||
      !['provisional', 'confirmed', 'overturned'].includes(d.lifecycle)
    ) {
      fail('invalid closed value');
    }
    const option = (n: number) => Number.isInteger(n) && n >= 1 && n <= d.options.length;
    if (
      !option(d.recommended) ||
      !option(d.taken) ||
      (d.overturn_option !== null && !option(d.overturn_option))
    ) {
      fail('option out of range');
    }
    for (const text of [d.why, d.outcome_note]) {
      if (text !== null && !text.trim()) {
        fail('blank optional text must be null');
      }
    }
    if (d.delivery !== null && deliveries.get(d.delivery)?.project_key !== d.project_key) {
      fail('delivery missing or in another project');
    }
    if (new Set(d.tasks).size !== d.tasks.length) {
      fail('duplicate task link');
    }
    for (const id of d.tasks) {
      const task = nodes.get(id);
      if (task?.type !== 'task' || task.project_id !== d.project_key) {
        fail(`link ${id} must name a same-project task`);
      }
    }
    const life = d.history.filter((h) => h.kind === 'lifecycle');
    if (d.lifecycle === 'provisional') {
      if (life.length || d.overturn_option !== null || d.outcome_note !== null) {
        fail('provisional decision has outcome or lifecycle history');
      }
    } else {
      if (
        life.length !== 1 ||
        life[0]?.from_value !== 'provisional' ||
        life[0]?.to_value !== d.lifecycle ||
        life[0]?.reason !== d.outcome_note
      ) {
        fail('terminal decision requires exactly one matching lifecycle history row');
      }
      if (d.lifecycle === 'confirmed' && d.overturn_option !== null) {
        fail('confirmed decision has overturn_option');
      }
      if (
        d.lifecycle === 'overturned' &&
        ((d.overturn_option === null && d.outcome_note === null) || d.overturn_option === d.taken)
      ) {
        fail('invalid overturn answer');
      }
    }
    for (const h of d.history) {
      if (!isCanonicalInstant(h.at)) {
        fail('invalid history instant');
      }
      if (h.kind === 'link') {
        const task = h.task === null ? undefined : nodes.get(h.task);
        if (
          task?.type !== 'task' ||
          task.project_id !== d.project_key ||
          h.from_value !== null ||
          !['linked', 'unlinked'].includes(h.to_value ?? '') ||
          h.reason !== null
        ) {
          fail('invalid link history');
        }
      } else {
        if (h.task !== null) {
          fail('only link history names a task');
        }
        if (h.kind === 'delivery') {
          for (const id of [h.from_value, h.to_value]) {
            if (id !== null && deliveries.get(id)?.project_key !== d.project_key) {
              fail('invalid delivery history');
            }
          }
          if (h.reason !== null || h.from_value === h.to_value) {
            fail('invalid delivery event');
          }
        }
      }
    }
    // The links must be what their own history leaves, once the links and the
    // link rows are each valid; a bad link already carries its own fault.
    const linkFault = faults.some(
      (f) =>
        f.id === d.id &&
        (f.message.startsWith('link ') ||
          [
            'duplicate task link',
            'invalid link history',
            'only link history names a task',
          ].includes(f.message)),
    );
    if (!linkFault) {
      const replayed = new Set<string>();
      for (const h of d.history) {
        if (h.kind === 'link' && h.task !== null) {
          if (h.to_value === 'linked') {
            replayed.add(h.task);
          } else {
            replayed.delete(h.task);
          }
        }
      }
      if (replayed.size !== d.tasks.length || d.tasks.some((id) => !replayed.has(id))) {
        fail('tasks disagree with link history');
      }
    }
    if (!isCanonicalInstant(d.created_at) || !isCanonicalInstant(d.updated_at)) {
      fail('invalid instant');
    }
  }
  return faults;
}
