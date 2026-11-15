import type { DecisionView } from '@mimir/contract';
import { formatInstant } from '@mimir/helpers';

import { hangingIndent } from './node';
import { arrow } from './presentation';
import type { Presentation } from './presentation';
import { recordViews } from './views';

export type DecisionValue = { decision: DecisionView; presentation: Presentation };

/** A record field as text: instants in the caller's zone (ADR 0029), lists joined. */
function fieldText(key: string, value: unknown, zone: string): string {
  if (key.endsWith('_at')) {
    return formatInstant(String(value), zone);
  }
  return Array.isArray(value) ? value.join(', ') : String(value);
}

/** The full decision and its append-only log, using the delivery record layout. */
export function renderDecision(decision: DecisionView, p: Presentation): string {
  const { history, options, ...fields } = decision;
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== null)
    .map(([key, value]) => hangingIndent(`${key}: `, fieldText(key, value, p.zone)));
  lines.push(
    'Options',
    ...options.map((text, index) => hangingIndent(`  ${String(index + 1)}. `, text)),
  );
  if (history.length) {
    lines.push(
      'History',
      ...history.map((h) => {
        const head = `${formatInstant(h.at, p.zone)} ${h.kind}: ${h.from_value ?? 'none'} ${arrow(p.plain)} ${h.to_value ?? 'none'}${h.task === null ? '' : ` ${h.task}`}`;
        return h.reason === null ? head : hangingIndent(`${head}: `, h.reason);
      }),
    );
  }
  return lines.join('\n');
}
export const decisionEchoViews = recordViews<DecisionValue>({
  ids: (v) => v.decision.id,
  json: (v) => v.decision,
  records: (v) => renderDecision(v.decision, v.presentation),
});
