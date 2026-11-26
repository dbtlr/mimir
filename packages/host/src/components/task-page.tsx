import type { EngineNode, EngineOutput, EngineTree, Grooming } from '@mimir/contract';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { browserTimeZone } from '../api/queries';
import { dayAndTime } from '../lib/day-folds';
import { visibleGrooming } from '../lib/grooming';
import { externalRefText } from '../lib/links';
import { projectKeyOf } from '../lib/project-key';
import { absoluteTime, ago } from '../lib/time';
import type { HistoryEntry, NodeAnnotation } from '../lib/timeline';
import { verdictSummary } from '../lib/verdict';
import { GroomWithAgentCard } from './agent-card';
import { LinkifiedText } from './linkified-text';
import { MarkdownBody } from './markdown-body';
import { ExternalRef, holdLabel, prerequisiteRows } from './node-record';
import { OpenInT3 } from './open-in-t3';
import { FACT_LINK_CLASS, Fact, FactMono, Facts } from './patterns/facts';
import { BannerFacts, BannerLabel, BannerText, StateBanner } from './patterns/state-banner';
import { recordTrail } from './record-head';
import { OpenEndedBadge, StaleBadge } from './signal-badges';
import { StatusBadge } from './status-badge';
import { StatusDot } from './status-dot';
import { Badge } from './ui/badge';
import { DetailsSection, RelationRow } from './work-page';

/*
 * A task's Work and Details tabs (ADR 0013 and ADR 0019, MMR-728
 * refinements). Work leads with one state banner when the state asks for
 * one, then the description at reading width, then what the task depends on
 * and what it blocks. Details holds the facts in three sections: Status,
 * Record, and Run. Their prose is `text-body`, 14 / 23.
 */

/** One active Scratchpad on the task's board, with the work it is anchored to. */
export type ScratchpadRow = EngineOutput<'scratchList'>[number];

/** A size in words, as Details names it. */
const SIZE_WORD: Record<NonNullable<EngineNode['size']>, string> = {
  large: 'Large',
  medium: 'Medium',
  small: 'Small',
};

/** A grooming state as Details' plain value; the header keeps the chip. */
const GROOMING_WORD: Record<Grooming, string> = {
  groomed: 'Groomed',
  needs_answers: 'Needs answers',
  not_groomed: 'Not groomed',
};

/** The latest entry of `history` that `matches`, as when a state began. */
function latest(
  history: EngineNode['history'],
  matches: (entry: HistoryEntry) => boolean,
): HistoryEntry | undefined {
  return (history ?? []).findLast(matches);
}

/** A run is live while the task is in progress with a session on it. */
function runIsLive(node: EngineNode): boolean {
  return node.status === 'in_progress' && (node.session ?? node.workerSession) != null;
}

/** The run's worker as a fact, in the banner and in Details › Run alike: its harness, then its session. */
function WorkerFact({ node }: { node: EngineNode }) {
  if (node.workerSession == null) {
    return null;
  }
  return (
    <Fact label="Worker">
      {node.workerHarness != null && (
        <>
          <FactMono>{node.workerHarness}</FactMono>,{' '}
        </>
      )}
      <FactMono>{node.workerSession}</FactMono>
    </Fact>
  );
}

/** Agent at work: the latest note and how old it is, the run's harness and branch, and Open in T3. */
function AgentBanner({
  node,
  annotations,
}: {
  node: EngineNode;
  annotations: readonly NodeAnnotation[];
}) {
  const note = annotations.at(-1);
  const started = latest(node.history, (e) => e.kind === 'lifecycle' && e.to === 'in_progress');
  const since = note?.createdAt ?? started?.at;
  const facts = node.harness != null || node.workerSession != null || node.branch != null;
  return (
    <StateBanner
      title="Agent at work"
      dot={<StatusDot status="in_progress" />}
      age={since === undefined ? undefined : ago(since)}
    >
      {note !== undefined && (
        <>
          <BannerLabel>Latest note</BannerLabel>
          <BannerText>
            <MarkdownBody breaks size="body" clamp={3} className="max-w-[70ch]">
              {note.content}
            </MarkdownBody>
          </BannerText>
        </>
      )}
      {facts && (
        <BannerFacts>
          <Facts>
            {node.harness != null && (
              <Fact label="Harness">
                <FactMono>{node.harness}</FactMono>
              </Fact>
            )}
            <WorkerFact node={node} />
            {node.branch != null && (
              <Fact label="Branch">
                <FactMono>{node.branch}</FactMono>
              </Fact>
            )}
          </Facts>
        </BannerFacts>
      )}
      <OpenInT3
        look="card"
        harness={node.harness}
        host={node.host}
        session={node.session}
        className="mt-4"
      />
    </StateBanner>
  );
}

/** Submitted for review: what was written since the submit, and the external ref as its PR. */
function ReviewBanner({
  node,
  annotations,
}: {
  node: EngineNode;
  annotations: readonly NodeAnnotation[];
}) {
  const submitted = latest(node.history, (e) => e.kind === 'lifecycle' && e.to === 'under_review');
  const summary = verdictSummary(node.history, annotations);
  const ref = node.externalRef;
  return (
    <StateBanner
      title="Submitted for review"
      dot={<StatusDot status="under_review" />}
      age={submitted === undefined ? undefined : ago(submitted.at)}
    >
      {summary !== undefined && (
        <BannerText>
          <MarkdownBody breaks size="body" className="max-w-[70ch]">
            {summary}
          </MarkdownBody>
        </BannerText>
      )}
      {ref != null && (
        <BannerFacts>
          <Facts>
            <Fact label={externalRefText(ref) === ref ? 'External ref' : 'Pull request'}>
              <ExternalRef value={ref} className={FACT_LINK_CLASS} />
            </Fact>
          </Facts>
        </BannerFacts>
      )}
    </StateBanner>
  );
}

/**
 * A hold: its name, its reason, and how long it has held. Blocked on you
 * takes the attention violet; a block on others, or a park, stays neutral.
 */
function HoldBanner({ node, hold }: { node: EngineNode; hold: 'blocked' | 'parked' }) {
  const reason = node.holdReason?.trim() ?? '';
  const held = latest(node.history, (e) => e.kind === 'hold' && e.to === hold);
  const onYou = hold === 'blocked' && node.blockOwner === 'you';
  return (
    <StateBanner
      title={holdLabel(hold, node.blockOwner)}
      {...(onYou ? { tone: 'attention' as const } : { dot: <StatusDot status={hold} /> })}
      age={held === undefined ? undefined : ago(held.at)}
    >
      {reason !== '' && (
        <BannerText>
          <p>
            <LinkifiedText>{reason}</LinkifiedText>
          </p>
        </BannerText>
      )}
    </StateBanner>
  );
}

/**
 * The one banner a task's state calls for, or null: Agent at work while a run
 * is live, Submitted for review in review, and a hold (a park only with its
 * reason). A finished task, or one waiting to start, has none.
 */
function stateBanner(node: EngineNode, annotations: readonly NodeAnnotation[]): ReactNode {
  if (runIsLive(node)) {
    return <AgentBanner node={node} annotations={annotations} />;
  }
  if (node.status === 'under_review') {
    return <ReviewBanner node={node} annotations={annotations} />;
  }
  if (node.hold === 'blocked') {
    return <HoldBanner node={node} hold="blocked" />;
  }
  if (node.hold === 'parked' && (node.holdReason?.trim() ?? '') !== '') {
    return <HoldBanner node={node} hold="parked" />;
  }
  return null;
}

/** What a task depends on or blocks: its count in the heading, then a row per task. */
function Relations({
  title,
  rows,
}: {
  title: string;
  rows: NonNullable<EngineNode['deps']>['blocking'];
}) {
  return (
    <DetailsSection title={title} count={rows.length} ruled={false}>
      <div>
        {rows.map((r) => (
          <RelationRow key={r.id} refNode={r} stacked />
        ))}
      </div>
    </DetailsSection>
  );
}

/**
 * A task's Work tab: the state's banner, or the Groom with agent card in its
 * place before the task is groomed; the description at reading width; then a
 * hairline, and what it depends on and what it blocks.
 */
export function TaskWork({
  node,
  annotations,
  offline,
}: {
  node: EngineNode;
  annotations: readonly NodeAnnotation[];
  offline: boolean;
}) {
  const description = node.description?.trim() ?? '';
  const prerequisites = node.deps === undefined ? [] : prerequisiteRows(node.deps);
  const blocking = node.deps?.blocking ?? [];
  return (
    <div className="flex flex-col gap-6">
      {stateBanner(node, annotations) ?? <GroomWithAgentCard node={node} offline={offline} />}
      {description === '' ? (
        <p className="text-body leading-[23px] text-ink">No description.</p>
      ) : (
        <MarkdownBody breaks size="body" className="max-w-[70ch]">
          {description}
        </MarkdownBody>
      )}
      {(prerequisites.length > 0 || blocking.length > 0) && (
        <div className="flex flex-col gap-7 border-t border-line pt-6">
          {prerequisites.length > 0 && <Relations title="Depends on" rows={prerequisites} />}
          {blocking.length > 0 && <Relations title="Blocks" rows={blocking} />}
        </div>
      )}
    </div>
  );
}

/** Whether any of a task's run facts is set: then Details shows its Run. */
function hasRunFacts(node: EngineNode, scratchpads: readonly ScratchpadRow[]): boolean {
  return (
    node.harness != null ||
    node.session != null ||
    node.workerSession != null ||
    node.branch != null ||
    node.host != null ||
    scratchpads.length > 0
  );
}

/** The parent as a fact: its title, linked to its page, from the header's trail. */
function ParentFact({ node, tree }: { node: EngineNode; tree: EngineTree | undefined }) {
  const parent = recordTrail(projectKeyOf(node.id), tree, node.id).at(-1);
  if (parent === undefined) {
    return null;
  }
  return (
    <Fact label="Parent">
      <Link {...parent.to} className={FACT_LINK_CLASS}>
        {parent.label}
      </Link>
    </Fact>
  );
}

/** Details › Run: every run fact that is set, whatever the status, then Open in T3. */
function RunSection({
  node,
  scratchpads,
}: {
  node: EngineNode;
  scratchpads: readonly ScratchpadRow[];
}) {
  return (
    <DetailsSection title="Run">
      <Facts>
        {node.harness != null && (
          <Fact label="Harness">
            <FactMono>{node.harness}</FactMono>
          </Fact>
        )}
        {node.session != null && (
          <Fact label="Main session">
            <FactMono>{node.session}</FactMono>
          </Fact>
        )}
        <WorkerFact node={node} />
        {node.branch != null && (
          <Fact label="Branch">
            <FactMono>{node.branch}</FactMono>
          </Fact>
        )}
        {node.host != null && (
          <Fact label="Host">
            <FactMono>{node.host}</FactMono>
          </Fact>
        )}
        {scratchpads.map((s) => (
          <Fact key={s.id} label="Scratchpad">
            {s.title}
          </Fact>
        ))}
      </Facts>
      <OpenInT3
        look="page"
        harness={node.harness}
        host={node.host}
        session={node.session}
        className="mt-5"
      />
    </DetailsSection>
  );
}

/** An instant as a Record fact: in the timeline's voice, the full zoned time in its title. */
function FactTime({ at }: { at: Date }) {
  return (
    <time dateTime={at.toISOString()} title={absoluteTime(at)}>
      {dayAndTime(at, browserTimeZone())}
    </time>
  );
}

/**
 * A task's Details tab: Status (the status, its signals, and grooming before
 * it starts), Record (its parent, dates, and external ref), and Run, which a
 * task that never ran has none of.
 */
export function TaskDetails({
  node,
  tree,
  scratchpads,
}: {
  node: EngineNode;
  tree: EngineTree | undefined;
  scratchpads: readonly ScratchpadRow[];
}) {
  const grooming = visibleGrooming(node);
  const tags = node.tags ?? [];
  const signals = node.open_ended === true || node.verdicts?.stale === true;
  return (
    <div className="flex flex-col">
      <DetailsSection title="Status">
        <Facts>
          <Fact label="Status">
            <StatusBadge status={node.status} />
          </Fact>
          {node.size != null && <Fact label="Size">{SIZE_WORD[node.size]}</Fact>}
          {node.priority != null && (
            <Fact label="Priority">
              <FactMono>{node.priority}</FactMono>
            </Fact>
          )}
          {grooming !== undefined && <Fact label="Grooming">{GROOMING_WORD[grooming]}</Fact>}
          {tags.length > 0 && (
            <Fact label="Tags">
              <span className="flex flex-wrap gap-1">
                {tags.map((t) => (
                  <Badge key={t.tag} variant="mono">
                    {t.tag}
                  </Badge>
                ))}
              </span>
            </Fact>
          )}
          {signals && (
            <Fact label="Signals">
              <span className="flex flex-wrap gap-1">
                {node.open_ended === true && <OpenEndedBadge />}
                {node.verdicts?.stale === true && <StaleBadge />}
              </span>
            </Fact>
          )}
        </Facts>
      </DetailsSection>
      <DetailsSection title="Record">
        <Facts>
          <ParentFact node={node} tree={tree} />
          <Fact label="Created">
            <FactTime at={node.createdAt} />
          </Fact>
          <Fact label="Updated">
            <FactTime at={node.updatedAt} />
          </Fact>
          <Fact label="Completed">
            {node.completedAt == null ? (
              <span className="text-ink-dim">Not yet</span>
            ) : (
              <FactTime at={node.completedAt} />
            )}
          </Fact>
          {node.target != null && <Fact label="Target">{node.target}</Fact>}
          {node.externalRef != null && (
            <Fact label="External ref">
              <ExternalRef value={node.externalRef} className={FACT_LINK_CLASS} />
            </Fact>
          )}
        </Facts>
      </DetailsSection>
      {hasRunFacts(node, scratchpads) && <RunSection node={node} scratchpads={scratchpads} />}
    </div>
  );
}
