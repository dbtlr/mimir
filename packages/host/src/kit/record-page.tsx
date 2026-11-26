import type { ReactNode } from 'react';

import { MarkdownBody } from '../components/markdown-body';
import { ExternalRef } from '../components/node-record';
import { Composer } from '../components/patterns/composer';
import { Fact, FactMono, Facts } from '../components/patterns/facts';
import { DayFolds } from '../components/patterns/feed/day-fold';
import type { FoldDay } from '../components/patterns/feed/day-fold';
import { ThreadDot, ThreadEvent, ThreadNote } from '../components/patterns/feed/thread';
import {
  BannerFacts,
  BannerLabel,
  BannerText,
  StateBanner,
} from '../components/patterns/state-banner';
import { StatusDot } from '../components/status-dot';
import { Section } from './section';

/*
 * A task page's own pieces (ADR 0019, MMR-728 refinement): the state banners
 * Work leads with, the Facts that Details and a banner hold, and the record
 * timeline's threaded day folds with its composer, on the page surface.
 */

/** One sample on the page surface, as a record page shows it. */
function Sample({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-well-900 p-4 max-md:px-3.5">
      <span className="font-mono text-mono-id text-ink-dim">{label}</span>
      {children}
    </div>
  );
}

const noop = () => {};

const LONG_NOTE = [
  '`notificationclick` now reads `data.path` from the payload and looks for an open console tab first:',
  '',
  '- a tab already on the record’s page gets `focus()`;',
  '- any other console tab gets `navigate(path)`, then `focus()`;',
  '- with no tab open, `clients.openWindow(path)`.',
  '',
  'The payload builder adds `path` beside `title` and `project`, so the subscriptions need no change. Installed iOS apps ignore `navigate()` on a tab that is not focused, so the handler focuses first and navigates second.',
  '',
  'Left for this task:',
  '',
  '1. Tag repeat pushes for one record with its ID.',
  '2. Cover the three branches with a fake `clients`.',
  '3. Check the notification icon at 1x and 2x on Android.',
  '',
  'Open question for review: should a tap on a decision’s notification open the record or the Needs you page?',
].join('\n');

const DAYS: FoldDay[] = [
  {
    count: 4,
    key: 'today',
    label: 'Today',
    rows: [
      <ThreadNote key="n2" time="14:52">
        <MarkdownBody breaks size="body" clamp={12} className="max-w-[70ch]">
          {LONG_NOTE}
        </MarkdownBody>
      </ThreadNote>,
      <ThreadEvent key="e2" dot={<ThreadDot className="bg-status-in-progress" />} time="14:10">
        <span className="font-medium text-ink-bright">Started</span>{' '}
        <span className="font-mono text-meta text-ink-dim">main worker</span>
      </ThreadEvent>,
      <ThreadEvent key="e1" dot={<ThreadDot className="bg-ink-dim" />} time="13:58">
        <span className="font-medium text-ink-bright">
          Session assignment changed after the worker picked the task back up from the queue
        </span>{' '}
        <span className="font-mono text-meta text-ink-dim">main</span>
      </ThreadEvent>,
      <ThreadNote key="n1" time="11:30">
        <p className="text-body text-ink">
          MMR-709 landed, so the subscription row carries the record’s ID.
        </p>
      </ThreadNote>,
    ],
  },
  {
    count: 1,
    key: 'yesterday',
    label: 'Yesterday',
    rows: [
      <ThreadEvent key="q" dot={<ThreadDot className="bg-status-queued" />} time="11:28">
        <span className="font-medium text-ink-bright">Queued</span>
      </ThreadEvent>,
    ],
  },
];

export function RecordPageKit() {
  return (
    <Section title="Task page: state banners, facts, and the record timeline">
      <Sample label="agent at work · latest note · facts">
        <StateBanner title="Agent at work" dot={<StatusDot status="in_progress" />} age="12m ago">
          <BannerLabel>Latest note</BannerLabel>
          <BannerText>
            <p>Wired notificationclick to focus an open console tab before opening a new one.</p>
          </BannerText>
          <BannerFacts>
            <Facts>
              <Fact label="Harness">
                <FactMono>claude-code</FactMono>
              </Fact>
              <Fact label="Branch">
                <FactMono>feat/mmr-710-push-open-record-with-a-long-branch-name</FactMono>
              </Fact>
            </Facts>
          </BannerFacts>
        </StateBanner>
      </Sample>
      <Sample label="submitted for review · a link fact">
        <StateBanner
          title="Submitted for review"
          dot={<StatusDot status="under_review" />}
          age="2h ago"
        >
          <BannerText>
            <p>A tap focuses an open console tab and navigates it, or opens one at the record.</p>
          </BannerText>
          <BannerFacts>
            <Facts>
              <Fact label="Pull request">
                <ExternalRef value="https://github.com/example/mimir/pull/653" />
              </Fact>
            </Facts>
          </BannerFacts>
        </StateBanner>
      </Sample>
      <Sample label="blocked on you · attention">
        <StateBanner title="Blocked on you" tone="attention" age="1d ago">
          <BannerText>
            <p>Needs the VAPID key pair for the production host.</p>
          </BannerText>
        </StateBanner>
      </Sample>
      <Sample label="blocked on others · neutral, no reason">
        <StateBanner title="Blocked on others" dot={<StatusDot status="blocked" />} age="3h ago" />
      </Sample>
      <Sample label="timeline · composer, then threaded day folds">
        <div className="pb-6">
          <Composer
            label="Add a note"
            placeholder="Add a note"
            commitLabel="Add note"
            onCommit={noop}
          />
        </div>
        <DayFolds days={DAYS} cap={Number.POSITIVE_INFINITY} thread />
      </Sample>
    </Section>
  );
}
