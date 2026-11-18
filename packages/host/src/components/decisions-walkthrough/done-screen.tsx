import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { Ref } from 'react';

import type { DecisionAnswerResult } from '../../api/fns/deliveries';
import { reviewQuery } from '../../api/view-queries';
import { deliveryLink } from '../../lib/record-url';
import { decisionCount } from './copy';
import { CheckGlyph } from './icons';
import { setOfDecision } from './model';
import type { WalkDecision, WalkScope } from './model';
import { PageLink } from './page-link';
import { MetaLine, Outcome, Scroll, ScreenHeading } from './parts';

/** An answer's result as the Send answered it; the record carries the tasks sent back. */
export type SendResult = DecisionAnswerResult<{ tasks: string[] }>;

const LINK_CLASS =
  'rounded-sm font-semibold text-accent-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent max-md:inline-flex max-md:min-h-11 max-md:items-center';

/**
 * The next set waiting: the first decision of the review read's queue whose
 * set is not this one, with the number of decisions its set holds. The queue
 * is the needs-you order across projects the focus queue walks.
 */
function NextSet({ current }: { current: string }) {
  const review = useQuery(reviewQuery());
  const report = review.data;
  if (report === undefined) {
    return null;
  }
  const decisions = report.needsYou
    .flatMap((group) => group.rows)
    .flatMap((row) => (row.kind === 'decision' ? [row.decision] : []));
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const head = report.queue
    .filter((entry) => entry.kind === 'decision')
    .map((entry) => byId.get(entry.id))
    .find((d) => d !== undefined && setOfDecision(d) !== current);
  if (head === undefined) {
    return null;
  }
  const set = setOfDecision(head);
  const count = decisions.filter((d) => setOfDecision(d) === set).length;
  const forDelivery = head.delivery !== null;
  return (
    <p className="mt-[18px] flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg bg-attention/10 px-3.5 py-3 text-ink-bright">
      <span>
        {forDelivery
          ? `${set} has ${decisionCount(count)} for you`
          : `${set} has ${decisionCount(count)} without a delivery`}
      </span>
      {forDelivery ? (
        <Link {...deliveryLink(set)} search={{ mode: 'decisions' }} className={LINK_CLASS}>
          Review them
        </Link>
      ) : (
        <Link
          to="/p/$key"
          params={{ key: set }}
          search={{ mode: 'decisions' }}
          className={LINK_CLASS}
        >
          Review them
        </Link>
      )}
    </p>
  );
}

/**
 * What a Send did (ADR 0019, MMR-703 refinement: After Send): what was
 * recorded and the tasks sent back, each refused or failed answer with its
 * reason, the next set waiting, and the way back to the page.
 */
export function DoneScreen({
  scope,
  decisions,
  results,
  headingRef,
}: {
  scope: WalkScope;
  decisions: readonly WalkDecision[];
  results: readonly SendResult[];
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const question = (id: string) => decisions.find((d) => d.id === id)?.question ?? id;
  const recorded = results.filter((r) => r.outcome === 'confirmed' || r.outcome === 'overturned');
  const notRecorded = results.filter((r) => r.outcome === 'refused' || r.outcome === 'failed');
  const rework = [
    ...new Set(recorded.flatMap((r) => (r.outcome === 'overturned' ? r.record.tasks : []))),
  ];
  const current = scope.kind === 'delivery' ? scope.id : scope.key;
  return (
    <section aria-label="Result" className="flex min-h-0 flex-1 flex-col">
      <Scroll>
        <MetaLine>
          <span className="flex items-center gap-1.5 font-semibold text-status-done-foreground">
            <CheckGlyph />
            Done
          </span>
        </MetaLine>
        <ScreenHeading headingRef={headingRef} className="mb-2.5 text-header md:text-[24px]">
          {scope.kind === 'delivery' ? 'Answers sent' : 'Answers recorded'}
        </ScreenHeading>
        <p className="mb-2 max-w-[52ch] text-ink">
          {recorded.length === 0
            ? 'No answer was recorded.'
            : `${decisionCount(recorded.length)} recorded.`}
          {rework.length > 0 &&
            ` ${rework.join(', ')} ${rework.length === 1 ? 'goes' : 'go'} back for rework.`}
        </p>
        {recorded.length > 0 && (
          <ul aria-label="Recorded" className="mb-2 flex flex-col gap-1 text-body">
            {recorded.map((r) => (
              <li key={r.id} className="wrap-anywhere text-ink-dim">
                <Outcome confirmed={r.outcome === 'confirmed'} />
                {question(r.id)}
              </li>
            ))}
          </ul>
        )}
        {notRecorded.length > 0 && (
          <div className="mt-3">
            <p className="mb-1 text-meta font-semibold text-status-blocked-foreground">
              Not recorded
            </p>
            <ul aria-label="Not recorded" className="flex flex-col gap-2 text-body">
              {notRecorded.map((r) => (
                <li key={r.id} className="wrap-anywhere">
                  <span className="text-ink-bright">{question(r.id)}</span>
                  <span className="block text-meta text-ink-dim">
                    {r.outcome === 'refused'
                      ? r.reason
                      : 'This answer failed and was not recorded.'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <NextSet current={current} />
        <p className="mt-[18px]">
          <PageLink scope={scope} className={LINK_CLASS} />
        </p>
      </Scroll>
    </section>
  );
}
