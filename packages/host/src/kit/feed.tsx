import type { StatusWord as Status } from '@mimir/contract';

import { GroomingBadge } from '../components/grooming-chip';
import { FeedCard } from '../components/patterns/feed/card';
import { CardGrid } from '../components/patterns/feed/card-grid';
import { DayFolds, FinishedRow } from '../components/patterns/feed/day-fold';
import { FeedPreview } from '../components/patterns/feed/feed-preview';
import type { Preview } from '../components/patterns/feed/preview-panel';
import { Quiet } from '../components/patterns/feed/quiet';
import { RowGroup } from '../components/patterns/feed/row-group';
import type { RowGroupRow } from '../components/patterns/feed/row-group';
import { FeedSection } from '../components/patterns/feed/section-head';
import { ShippedSummary } from '../components/patterns/feed/shipped-summary';
import type { ShippedDay } from '../components/patterns/feed/shipped-summary';
import { SizeBadge, StaleBadge } from '../components/signal-badges';
import { StatusBadge, StatusWord } from '../components/status-badge';
import { StatusDot } from '../components/status-dot';
import { ActionButton } from '../components/ui/action-button';
import { nodeLink } from '../lib/record-url';
import { Section } from './section';

/*
 * The feed blocks (ADR 0019, MMR-719 refinement) at real volumes: a Home-like
 * slice, finished work in day folds, a quiet page, and long data. Which blocks
 * a page takes is that page's task; this is the blocks' showcase.
 */

const project = (key: string) => ({ params: { key }, to: '/p/$key' as const });
const tasks = (key: string, status: string) => ({
  params: { key },
  search: { status },
  to: '/p/$key/tasks' as const,
});

/** The lead of a card that stands for a project's set of provisional decisions. */
function DecisionsLead({ project: name }: { project: string }) {
  return (
    <>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="inline-block size-[7px] shrink-0 rounded-full bg-attention" />
        <StatusWord>Decisions</StatusWord>
      </span>{' '}
      <span>{name}</span>
    </>
  );
}

const WEEK: ShippedDay[] = [
  { count: 41, name: 'Monday', short: 'Mon' },
  { count: 47, name: 'Tuesday', short: 'Tue' },
  { count: 50, name: 'Wednesday', short: 'Wed' },
  { count: 28, name: 'Thursday', short: 'Thu' },
  { count: 12, name: 'Friday', short: 'Fri' },
  { count: 6, name: 'Saturday', short: 'Sat' },
  { count: 7, name: 'today', short: 'Today' },
];

const BY_PROJECT: RowGroupRow[] = [
  { count: 71, key: 'LM', name: 'Loom CLI', to: project('LM') },
  { count: 52, key: 'NORN', name: 'Norn', to: project('NORN') },
  { count: 34, key: 'MMR', name: 'Mimir', to: project('MMR') },
];

const SPARE_MINUTE: RowGroupRow[] = [
  { count: 12, name: 'Seeds to triage', to: { params: { key: 'MMR' }, to: '/p/$key/seeds' } },
  { count: 15, name: 'To groom', to: tasks('MMR', 'ready') },
  { count: 44, name: 'Going cold', to: tasks('MMR', 'live') },
  { count: 0, name: 'Waiting on others', to: tasks('MMR', 'awaiting') },
];

function finished(id: string, status: Status, title: string, time: string, absorbedBy?: string) {
  return (
    <FinishedRow
      key={id}
      to={nodeLink(id)}
      dot={<StatusDot status={status} />}
      status={status === 'abandoned' ? 'Abandoned' : 'Done'}
      title={title}
      time={time}
      note={
        absorbedBy === undefined ? undefined : (
          <>
            <StatusWord>Abandoned</StatusWord>: absorbed by{' '}
            <span className="font-mono">{absorbedBy}</span>
          </>
        )
      }
    />
  );
}

const DAYS = [
  {
    count: 7,
    key: '2026-11-22',
    label: 'Today',
    rows: [
      finished('MMR-718', 'done', 'Readable type and contrast on every console page', '08:06'),
      finished('MMR-746', 'done', 'Build on Loom 0.20.0, and bump the minor below 1.0', '06:25'),
      finished(
        'MMR-737',
        'abandoned',
        'Move the stop-run dialog onto ConfirmCard',
        '05:12',
        'MMR-740',
      ),
      finished('MMR-750', 'done', 'Declare release.yml’s macOS build row as a Hugi lane', '04:40'),
      finished('MMR-743', 'done', 'Forms share one Form sheet and one Record picker', '03:58'),
      finished('MMR-744', 'done', 'Composer and Walkthrough patterns', '02:31'),
      finished('MMR-742', 'done', 'Action menu and Notice patterns', '01:14'),
    ],
  },
  {
    count: 1,
    key: '2026-11-21',
    label: 'Saturday 21 November',
    rows: [
      finished(
        'MMR-697',
        'done',
        'Declare readOnly and destructive hints on every mcp tool',
        '22:41',
      ),
    ],
  },
  {
    count: 1,
    key: '2026-11-20',
    label: 'Friday 20 November',
    rows: [finished('MMR-712', 'done', 'Choose what notifies each browser', '19:02')],
  },
];

/** A kit action: it hands focus on to the card's own button, where a real surface's opener would be. */
const handOn = (cardButton: HTMLElement | null) => {
  cardButton?.focus();
};

/** A short preview for each card in the blocks' showcase; the Preview panel section has the full ones. */
function feedPreview(key: string): Preview | undefined {
  const card = FEED_CARDS[key];
  return card === undefined ? undefined : { ...card, open: nodeLink(key) };
}

const FEED_CARDS: Record<string, Omit<Preview, 'open'>> = {
  'HUGI-15': {
    action: { label: 'Answer', name: 'Answer HUGI-15', onAction: handOn },
    id: 'HUGI-15',
    lead: <StatusBadge status="ready" />,
    reason: 'Needs an answer before it can start.',
    title: 'Keep run logs and make them readable',
  },
  'I18N-1': {
    action: { label: 'Review 123 decisions', onAction: handOn },
    lead: <DecisionsLead project="Internationalization infrastructure modernization" />,
    reason: 'This project has 123 provisional decisions without a delivery.',
    title: 'InternationalizationInfrastructureMigrationPlanForEveryLocale',
  },
  'LM-561': {
    id: 'LM-561',
    lead: <StatusBadge status="in_progress" />,
    reason: 'Going cold: nothing has moved in six days.',
    title: 'Reuse the command graph between runs',
  },
  'MMR-706': {
    action: { label: 'Review 12 decisions', onAction: handOn },
    lead: <DecisionsLead project="Mimir" />,
    reason: 'This delivery has 12 provisional decisions.',
    title: 'Web Push notifications',
  },
  'MMR-709': {
    id: 'MMR-709',
    lead: <StatusBadge status="in_progress" />,
    reason: 'The agent is building it.',
    title: 'Send an encrypted Web Push to every subscribed device',
  },
  'MMR-715': {
    id: 'MMR-715',
    lead: <StatusBadge status="under_review" />,
    reason: 'Waiting on your review.',
    title: 'Mobile top bar: one icon size, 44px targets, and a solid bar',
  },
  'NORN-1536': {
    id: 'NORN-1536',
    lead: <StatusBadge status="under_review" />,
    reason: 'Waiting on your review, and going cold.',
    title:
      'Every release channel promotes only the highest verified version, even when two tags land in one minute',
  },
  'NORN-536': {
    id: 'NORN-536',
    lead: <StatusBadge status="in_progress" />,
    reason: 'The agent is building it.',
    title:
      'Layer 6.1 exit walk: a real host process serves the wire end to end under the release gate',
  },
};

export function FeedKit() {
  return (
    <Section title="Feed blocks">
      <FeedPreview preview={feedPreview}>
        <div className="flex max-w-[900px] flex-col">
          <FeedSection title="Needs you" count={24} seeAll={{ to: '/' }}>
            <CardGrid>
              <FeedCard
                previewKey="MMR-706"
                lead={<DecisionsLead project="Mimir" />}
                age="2h"
                title="Web Push notifications"
                detail="The agent kept building past these choices. Confirm or overturn them."
                action={
                  <ActionButton size="form" className="md:h-9">
                    Review 12 decisions
                  </ActionButton>
                }
              />
              <FeedCard
                previewKey="HUGI-15"
                lead={<StatusBadge status="ready" />}
                id="HUGI-15"
                age="1d"
                title="Keep run logs and make them readable"
                detail="Where are logs read: a command on Valhalla, or a tailnet page linked from the status?"
                chips={
                  <>
                    <GroomingBadge state="needs_answers" />
                    <SizeBadge size="medium" />
                  </>
                }
                action={
                  <ActionButton
                    size="form"
                    variant="formOutline"
                    className="md:h-9"
                    aria-label="Answer HUGI-15"
                  >
                    Answer
                  </ActionButton>
                }
              />
            </CardGrid>
          </FeedSection>
          <FeedSection title="Now" count={9} seeAll={tasks('MMR', 'live')}>
            <CardGrid>
              <FeedCard
                previewKey="MMR-715"
                lead={<StatusBadge status="under_review" />}
                id="MMR-715"
                age="15m"
                title="Mobile top bar: one icon size, 44px targets, and a solid bar"
                chips={<SizeBadge size="small" />}
              />
              <FeedCard
                previewKey="MMR-709"
                lead={<StatusBadge status="in_progress" />}
                id="MMR-709"
                age="50m"
                title="Send an encrypted Web Push to every subscribed device"
                detail="Latest note: task agreement confirmed; the agent merges when CI is green and the review panel passes."
                chips={<SizeBadge size="large" />}
              />
              <FeedCard
                previewKey="NORN-536"
                lead={<StatusBadge status="in_progress" />}
                id="NORN-536"
                age="1h"
                title="Layer 6.1 exit walk: a real host process serves the wire end to end under the release gate"
                chips={<SizeBadge size="medium" />}
              />
              <FeedCard
                previewKey="LM-561"
                lead={<StatusBadge status="in_progress" />}
                id="LM-561"
                age="6d"
                title="Reuse the command graph between runs"
                chips={<StaleBadge />}
                cold
              />
            </CardGrid>
          </FeedSection>
          <FeedSection title="Shipped this week" count={191} seeAll={tasks('MMR', 'terminal')}>
            <ShippedSummary
              days={WEEK}
              breakdown={
                <RowGroup
                  label="Shipped by project"
                  rows={BY_PROJECT}
                  more={{ count: 34, name: '5 more projects', to: tasks('MMR', 'terminal') }}
                />
              }
            />
          </FeedSection>
          <FeedSection title="When you have a minute">
            <RowGroup label="When you have a minute" rows={SPARE_MINUTE} />
          </FeedSection>
          <FeedSection title="Finished, last 7 days" count={191}>
            <DayFolds days={DAYS} cap={4} />
          </FeedSection>
          {/* A quiet page: the quiet line stands where Needs you would be, and
            the quiet sentence for the sections that would follow. */}
          <div className="mt-8 border-t border-line pt-6">
            <p className="m-0 text-meta text-ink-dim">A quiet project page:</p>
            <Quiet>Nothing needs you.</Quiet>
            <Quiet>Nothing is running, nothing shipped this week, and nothing is going cold.</Quiet>
          </div>
          <FeedSection title="Long data" count={1204}>
            <CardGrid>
              <FeedCard
                previewKey="I18N-1"
                lead={<DecisionsLead project="Internationalization infrastructure modernization" />}
                age="3d"
                title="InternationalizationInfrastructureMigrationPlanForEveryLocale"
                action={
                  <ActionButton size="form" className="md:h-9">
                    Review 123 decisions
                  </ActionButton>
                }
              />
              <FeedCard
                previewKey="NORN-1536"
                lead={<StatusBadge status="under_review" />}
                id="NORN-1536"
                age="9d"
                title="Every release channel promotes only the highest verified version, even when two tags land in one minute"
                chips={
                  <>
                    <SizeBadge size="large" />
                    <StaleBadge />
                  </>
                }
                cold
              />
            </CardGrid>
            <div className="mt-3">
              <ShippedSummary
                days={[
                  { count: 0, name: 'Monday', short: 'Mon' },
                  { count: 18, name: 'Tuesday', short: 'Tue' },
                  { count: 12_418, name: 'Wednesday', short: 'Wed' },
                  { count: 6400, name: 'Thursday', short: 'Thu' },
                  { count: 310, name: 'Friday', short: 'Fri' },
                  { count: 0, name: 'Saturday', short: 'Sat' },
                  { count: 154, name: 'today', short: 'Today' },
                ]}
                breakdown={
                  <RowGroup
                    label="Shipped by project, long names"
                    rows={[
                      {
                        count: 12_018,
                        key: 'HUGI',
                        name: 'Hugi continuous integration lanes with audit and reporting for every runner',
                        to: project('HUGI'),
                      },
                    ]}
                  />
                }
              />
            </div>
          </FeedSection>
        </div>
      </FeedPreview>
    </Section>
  );
}
