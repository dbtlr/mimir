import { GroomingBadge } from '../components/grooming-chip';
import { FeedCard } from '../components/patterns/feed/card';
import { CardGrid } from '../components/patterns/feed/card-grid';
import { FeedPreview } from '../components/patterns/feed/feed-preview';
import { PreviewRelation } from '../components/patterns/feed/preview-panel';
import type { Preview } from '../components/patterns/feed/preview-panel';
import { SeedKindChip } from '../components/seed-kind-chip';
import { SizeBadge } from '../components/signal-badges';
import { LaneBadge, StatusBadge, StatusWord } from '../components/status-badge';
import { ActionButton } from '../components/ui/action-button';
import { nodeLink, seedLink } from '../lib/record-url';
import { Section } from './section';

/*
 * The preview panel (ADR 0019, MMR-720 refinement) over sample data: a task
 * waiting on an answer, a decision bundle, a seed, a card with no button, and a
 * task whose facts reach the phone sheet's 88% cap, and a bundle whose Tasks
 * fact is taller than the capped body. Tap a card to open its
 * preview, another to switch it; no page adopts the panel yet (MMR-722 on).
 */

/** No surface follows in /kit, so focus goes to the card's own button, the next surface's opener. */
const handOn = (cardButton: HTMLElement | null) => {
  cardButton?.focus();
};

/** The lead of a card that stands for a delivery's set of provisional decisions. */
function DecisionsLead({ project }: { project: string }) {
  return (
    <>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="inline-block size-[7px] shrink-0 rounded-full bg-attention" />
        <StatusWord>Decisions</StatusWord>
      </span>{' '}
      <span>{project}</span>
    </>
  );
}

const PREVIEWS: Record<string, Preview> = {
  'HUGI-15': {
    action: { label: 'Answer', name: 'Answer HUGI-15', onAction: handOn },
    age: '1d',
    facts: [
      { label: 'Parent', value: 'Hugi 0.4: run history' },
      { label: 'Size', value: 'Medium' },
      { label: 'Priority', value: 'High' },
      {
        label: 'Blocks',
        value: (
          <PreviewRelation
            id="HUGI-18"
            title="Link a failed lane to its log from the status page"
          />
        ),
      },
      { label: 'Ready since', value: 'Thursday 20 November' },
    ],
    id: 'HUGI-15',
    lead: <StatusBadge status="ready" />,
    open: nodeLink('HUGI-15'),
    reason: (
      <>
        <b>Needs an answer before it can start.</b> Where are logs read: a command on Valhalla, or a
        tailnet page linked from the status?
      </>
    ),
    text: 'Keep every lane’s log for 14 days after its run ends, and make it readable without a shell on the runner.',
    title: 'Keep run logs and make them readable',
  },
  'MMR-709': {
    age: '50m',
    facts: [
      { label: 'Parent', value: 'Mimir 0.6: Web Push' },
      { label: 'Size', value: 'Large' },
      { label: 'Started', value: 'Saturday 22 November' },
    ],
    id: 'MMR-709',
    lead: <StatusBadge status="in_progress" />,
    open: nodeLink('MMR-709'),
    reason: (
      <>
        <b>The agent is building it.</b> Latest note: task agreement confirmed; the agent merges
        when CI is green and the review panel passes.
      </>
    ),
    title: 'Send an encrypted Web Push to every subscribed device',
  },
  'MMR-s41': {
    action: { label: 'Promote to task…', onAction: handOn },
    age: '3h',
    facts: [
      { label: 'Kind', value: <SeedKindChip kind="bug" /> },
      {
        label: 'Filed from',
        value: <PreviewRelation id="MMR-718" title="Readable type and contrast" />,
      },
    ],
    id: 'MMR-s41',
    lead: <LaneBadge lane="untriaged" label="Untriaged" />,
    open: seedLink('MMR-s41'),
    reason: '“Don’t” finds nothing in Jump to…, though two tasks have it in their titles.',
    text: 'Searching for “don” finds both. Titles store a curly apostrophe, and the search box sends a straight one.',
    title: 'Search drops results when a title has an apostrophe',
  },
  'NORN-560': {
    action: { label: 'Answer', name: 'Answer NORN-560', onAction: handOn },
    age: '2d',
    facts: [
      { label: 'Parent', value: 'Norn 1.2: signed releases' },
      { label: 'Size', value: 'Large' },
      { label: 'Priority', value: 'High' },
      {
        label: 'Depends on',
        value: (
          <>
            <PreviewRelation
              id="NORN-541"
              title="Publish the signed macOS build to the release channel"
            />
            <PreviewRelation id="NORN-552" title="Read channel manifests from one place" />
          </>
        ),
      },
      {
        label: 'Blocks',
        value: (
          <>
            <PreviewRelation id="NORN-561" title="Show a pinned channel on the release page" />
            <PreviewRelation id="NORN-563" title="Unpin when a fixed build lands" />
          </>
        ),
      },
      { label: 'Tags', value: 'release, channels' },
      { label: 'External ref', value: 'github.com/norn/norn/issues/412' },
      { label: 'Ready since', value: 'Wednesday 19 November' },
      { label: 'Created', value: 'Monday 17 November' },
    ],
    id: 'NORN-560',
    lead: <StatusBadge status="ready" />,
    open: nodeLink('NORN-560'),
    reason: (
      <>
        <b>Needs two answers before it can start.</b> Does the pin live in the channel’s manifest or
        in the promoter’s config? And may an agent set a pin, or only the operator?
      </>
    ),
    text: 'A pinned channel stops promoting below the pinned version, so a bad build can be held back while its tag and artifacts stay in place for the post-mortem.',
    title:
      'Let a release channel pin a minimum version, so a bad build can be held back without deleting its tag',
  },
  'release-channels': {
    action: { label: 'Review 4 decisions', onAction: handOn },
    age: '5h',
    facts: [
      {
        label: 'Tasks',
        value: (
          <>
            <PreviewRelation
              id="LM-601"
              title="Read a channel's promotion rules from the manifest"
            />
            <PreviewRelation id="LM-602" title="Promote only the highest verified version" />
            <PreviewRelation id="LM-603" title="Hold a promotion while a newer tag is verifying" />
            <PreviewRelation id="LM-604" title="Record why each promotion happened" />
            <PreviewRelation id="LM-605" title="Show a channel's history on its release page" />
            <PreviewRelation id="LM-606" title="Let a channel follow another channel" />
            <PreviewRelation id="LM-607" title="Refuse a follow that would make a cycle" />
            <PreviewRelation id="LM-608" title="Pin a channel to a minimum version" />
            <PreviewRelation id="LM-609" title="Unpin when a fixed build lands" />
            <PreviewRelation id="LM-610" title="Name the operator who set a pin" />
            <PreviewRelation id="LM-611" title="Expire a pin after a set time" />
            <PreviewRelation id="LM-612" title="Warn when a pin holds back a security fix" />
            <PreviewRelation id="LM-613" title="Promote a rollback as its own release" />
            <PreviewRelation id="LM-614" title="Sign each promotion record" />
            <PreviewRelation id="LM-615" title="Verify a promotion record before it lands" />
            <PreviewRelation id="LM-616" title="Mirror channels to the offline cache" />
            <PreviewRelation id="LM-617" title="Read channel state from one place in the CLI" />
            <PreviewRelation id="LM-618" title="Print a channel's state as JSON" />
            <PreviewRelation id="LM-619" title="Diff two channels' versions" />
            <PreviewRelation id="LM-620" title="Document the channel lifecycle" />
          </>
        ),
      },
      { label: 'Oldest', value: '5 hours ago' },
    ],
    lead: <DecisionsLead project="Loom CLI" />,
    open: nodeLink('LM-600'),
    openId: 'LM-600',
    reason: 'This delivery has 4 provisional decisions.',
    title: 'Release channels',
  },
  'web-push': {
    action: { label: 'Review 12 decisions', onAction: handOn },
    age: '2h',
    facts: [
      {
        label: 'Tasks',
        value: (
          <>
            <PreviewRelation
              id="MMR-709"
              title="Send an encrypted Web Push to every subscribed device"
            />
            <PreviewRelation id="MMR-710" title="Store and rotate the VAPID keys" />
            <PreviewRelation id="MMR-712" title="Limit notices per device" />
          </>
        ),
      },
    ],
    lead: <DecisionsLead project="Mimir" />,
    open: nodeLink('MMR-706'),
    openId: 'MMR-706',
    reason: 'This delivery has 12 provisional decisions.',
    title: 'Web Push notifications',
  },
};

export function PreviewKit() {
  return (
    <Section title="Preview panel">
      <div className="flex max-w-[900px] flex-col gap-3" data-kit="preview">
        <p className="m-0 text-meta text-ink-dim">
          Tap a card to open its preview; tap another to switch it, the selected card to close it.
        </p>
        <FeedPreview preview={(key) => PREVIEWS[key]}>
          <CardGrid>
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
            <FeedCard
              previewKey="web-push"
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
              previewKey="MMR-s41"
              lead={<LaneBadge lane="untriaged" label="Untriaged" />}
              id="MMR-s41"
              age="3h"
              title="Search drops results when a title has an apostrophe"
              detail="“Don’t” finds nothing in Jump to…, though two tasks have it in their titles."
              action={
                <ActionButton size="form" variant="formOutline" className="md:h-9">
                  Promote to task…
                </ActionButton>
              }
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
              previewKey="NORN-560"
              lead={<StatusBadge status="ready" />}
              id="NORN-560"
              age="2d"
              title="Let a release channel pin a minimum version, so a bad build can be held back without deleting its tag"
              detail="Two questions before it can start: where the pin lives, and who may set it."
              chips={
                <>
                  <GroomingBadge state="needs_answers" />
                  <SizeBadge size="large" />
                </>
              }
              action={
                <ActionButton
                  size="form"
                  variant="formOutline"
                  className="md:h-9"
                  aria-label="Answer NORN-560"
                >
                  Answer
                </ActionButton>
              }
            />
            <FeedCard
              previewKey="release-channels"
              lead={<DecisionsLead project="Loom CLI" />}
              age="5h"
              title="Release channels"
              detail="Choices made while building the channel promoter, across 20 tasks."
              action={
                <ActionButton size="form" className="md:h-9">
                  Review 4 decisions
                </ActionButton>
              }
            />
          </CardGrid>
        </FeedPreview>
      </div>
    </Section>
  );
}
