import { DELIVERY_FINDING_KIND_VALUES } from '@mimir/contract';
import type { DeliveryFindingRecord } from '@mimir/contract';
import { isMember } from '@mimir/helpers';

import { isCanonicalInstant } from '../time';

/**
 * The rules the findings verbs and the run journal keep (ADR 0042 and ADR
 * 0027, MMR-691), checked on stored or imported rows. Import and doctor share
 * them, so a row one refuses the other reports.
 */

type Fault = { id: string; message: string };

/** The known deliveries: id to owning project key. */
export type DeliveryProjects = ReadonlyMap<string, string>;

/** Faults in a delivery's limitation and declined-finding entries. The entry is named `KEY-dN entry N`. */
export function deliveryFindingFaults(
  entries: readonly DeliveryFindingRecord[],
  deliveries: DeliveryProjects,
): Fault[] {
  const faults: Fault[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const id = `${entry.delivery} entry ${String(entry.number)}`;
    const fail = (message: string): void => {
      faults.push({ id, message });
    };
    if (!deliveries.has(entry.delivery)) {
      fail('names a missing delivery');
    }
    if (!Number.isInteger(entry.number) || entry.number < 1) {
      fail('number must be a positive integer');
    }
    const key = `${entry.delivery}|${String(entry.number)}`;
    if (seen.has(key)) {
      fail('number is used twice on its delivery');
    }
    seen.add(key);
    if (entry.text.trim() === '') {
      fail('text is blank');
    }
    // A stored row is untrusted: read the kind as the text it is.
    const kind: string = entry.kind;
    if (!isMember(kind, DELIVERY_FINDING_KIND_VALUES)) {
      fail('kind is outside limitation and declined');
    } else if (kind === 'declined' && (entry.reason === null || entry.reason.trim() === '')) {
      fail('is declined without a reason');
    } else if (kind === 'limitation' && entry.reason !== null) {
      fail('is a limitation but carries a reason');
    }
    if (!isCanonicalInstant(entry.created_at)) {
      fail('created_at is not a canonical UTC instant');
    }
  }
  return faults;
}

/** A pad or artifact and the delivery it names. */
export type JournalRef = { id: string; project: string; delivery: string | null };

/**
 * Faults in the `delivery` a pad or frozen artifact names: a missing or
 * other-project delivery, and a second live pad on one delivery.
 */
export function journalFaults(
  pads: readonly JournalRef[],
  artifacts: readonly JournalRef[],
  deliveries: DeliveryProjects,
): (Fault & { scope: string })[] {
  const faults: (Fault & { scope: string })[] = [];
  const holders = new Map<string, string[]>();
  const check = (kind: 'artifact' | 'scratchpad', ref: JournalRef): void => {
    if (ref.delivery === null) {
      return;
    }
    const project = deliveries.get(ref.delivery);
    const id = `${kind} ${ref.id}`;
    if (project === undefined) {
      faults.push({ id, message: `delivery ${ref.delivery} is missing`, scope: ref.project });
    } else if (project !== ref.project) {
      faults.push({
        id,
        message: `delivery ${ref.delivery} is in project ${project}, not ${ref.project}`,
        scope: ref.project,
      });
    }
  };
  for (const pad of pads) {
    check('scratchpad', pad);
    if (pad.delivery !== null) {
      holders.set(pad.delivery, [...(holders.get(pad.delivery) ?? []), pad.id]);
    }
  }
  for (const artifact of artifacts) {
    check('artifact', artifact);
  }
  for (const [delivery, ids] of holders) {
    if (ids.length > 1) {
      faults.push({
        id: `delivery ${delivery}`,
        message: `has ${String(ids.length)} live scratchpads: ${ids.toSorted().join(', ')}`,
        scope: deliveries.get(delivery) ?? '',
      });
    }
  }
  return faults;
}
