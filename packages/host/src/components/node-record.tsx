import type { EngineNode, NodeRef } from '@mimir/contract';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { useTag, useTransition, useUntag, useUpdateNode } from '../api/node-mutations';
import { cn } from '../lib/cn';
import { isBareUrl } from '../lib/links';
import { proseEdit } from '../lib/prose';
import { artifactLink, nodeLink } from '../lib/record-url';
import type { TaskFormValues } from '../lib/schemas';
import type { NodeAnnotation } from '../lib/timeline';
import { availableTransitions, transitionLabel } from '../lib/transitions';
import type { TransitionVerb, VerbSpec } from '../lib/transitions';
import { verdictSummary } from '../lib/verdict';
import type { RecordArtifact } from '../lib/work-page';
import { LinkifiedText } from './linkified-text';
import { MarkdownBody } from './markdown-body';
import { Reason } from './patterns/reason';
import { OpenEndedBadge, PriorityBadge, SizeBadge, StaleBadge } from './signal-badges';
import { StatusDot } from './status-dot';
import type { TaskFormSubmit } from './task-form';
import { Badge } from './ui/badge';

/*
 * The pieces of a work node's record page: links to other records, the verdict
 * block, the hold callout, detail rows, and the edit and transition wiring.
 */

/** A link to another work node's page: status dot, id, and title. */
export function RefRow({ refNode }: { refNode: NodeRef }) {
  return (
    <Link
      {...nodeLink(refNode.id)}
      className="flex min-w-0 items-center gap-2 rounded-sm px-1 py-0.5 text-left text-xs text-ink transition-colors hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent"
    >
      {refNode.status !== undefined && <StatusDot status={refNode.status} />}
      <span className="shrink-0 font-mono text-mono-id text-accent-foreground">{refNode.id}</span>
      {refNode.title !== undefined && (
        <span className="truncate text-ink-dim">{refNode.title}</span>
      )}
    </Link>
  );
}

/** Links to a record's artifacts, each at its own page (MMR-452). */
export function ArtifactLinks({ artifacts }: { artifacts?: readonly RecordArtifact[] }) {
  if (artifacts === undefined || artifacts.length === 0) {
    return <p className="text-xs text-ink-dim">None yet.</p>;
  }
  return (
    <div className="flex flex-col gap-0.5">
      {artifacts.map((a) => (
        <Link
          key={a.id}
          {...artifactLink(a.id)}
          className="flex min-w-0 items-center gap-2 rounded-sm px-1 py-0.5 text-xs text-ink transition-colors hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent"
        >
          <span aria-hidden className="text-accent-foreground select-none">
            ❄
          </span>
          <span className="truncate">{a.title}</span>
        </Link>
      ))}
    </div>
  );
}

/** A record's description as rendered markdown, or a quiet line when it has none. */
export function DescriptionSection({ description }: { description?: string | null }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h2 className="microlabel border-b border-line pb-1.5 text-ink-dim">Description</h2>
      {description != null && description.trim() !== '' ? (
        <MarkdownBody breaks className="max-w-none">
          {description}
        </MarkdownBody>
      ) : (
        <p className="text-xs text-ink-dim">No description.</p>
      )}
    </section>
  );
}

/**
 * Rows deduped by node id: each keeps its first-seen position and its
 * last-seen reading, so an inherited `awaitingOn` entry refreshes a stale
 * `dependsOn` one.
 */
function dedupe(...lists: (readonly NodeRef[] | undefined)[]): NodeRef[] {
  const rows = new Map<string, NodeRef>();
  for (const list of lists) {
    for (const r of list ?? []) {
      rows.set(r.id, r);
    }
  }
  return [...rows.values()];
}

/**
 * What a node waits on: its own prerequisites, then the ones it inherits from
 * an ancestor. An unsettled own prerequisite appears in both lists and gets
 * one row.
 */
export function prerequisiteRows(deps: NonNullable<EngineNode['deps']>): NodeRef[] {
  return dedupe(deps.dependsOn, deps.awaitingOn);
}

/** Does the node carry any signal: open-ended, priority, size, staleness, or tags? */
export function hasSignals(node: EngineNode): boolean {
  return (
    node.open_ended === true ||
    node.priority != null ||
    node.size != null ||
    node.verdicts?.stale === true ||
    (node.tags?.length ?? 0) > 0
  );
}

/** A node's signals as badges; render it only when {@link hasSignals} holds. */
export function SignalBadges({ node }: { node: EngineNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {node.open_ended === true && <OpenEndedBadge />}
      {node.priority != null && <PriorityBadge priority={node.priority} />}
      {node.size != null && <SizeBadge size={node.size} />}
      {node.verdicts?.stale === true && <StaleBadge />}
      {node.tags?.map((t) => (
        <Badge key={t.tag} variant="mono">
          {t.tag}
        </Badge>
      ))}
    </div>
  );
}

/**
 * externalRef is free text (e.g. `GH-123`, `PR #41`): a URL renders as a `↗` link,
 * anything else as plain mono text (no dead link).
 */
export function ExternalRef({ value }: { value: string }) {
  if (isBareUrl(value)) {
    return (
      <a
        href={value}
        target="_blank"
        rel="noopener noreferrer"
        className="self-start font-mono text-mono-id break-all text-accent-foreground hover:text-accent"
      >
        {value} ↗
      </a>
    );
  }
  return <span className="font-mono text-mono-id text-ink-dim">{value}</span>;
}

export function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 text-tag">
      <dt className="text-ink-dim">{label}</dt>
      <dd className="min-w-0 text-right font-mono break-words text-ink">{children}</dd>
    </div>
  );
}

/** Hold-reason callout wash, keyed to the hold kind (parked ≠ blocked hue); the label reads in bright ink (MMR-718). */
const HOLD_CALLOUT: Record<'blocked' | 'parked', string> = {
  blocked: 'bg-status-blocked/10 inset-ring-status-blocked/24',
  parked: 'bg-status-parked/10 inset-ring-status-parked/24',
};

/** The callout's lead: a block names who can clear it; a park, a legacy block without an owner, just the hold. */
function holdLabel(hold: 'blocked' | 'parked', owner: EngineNode['blockOwner']): string {
  return hold === 'blocked' && owner != null ? `Blocked on ${owner}` : hold;
}

/**
 * A held task's callout: its reason when it gives one, and for a block, who can
 * clear it. A block always shows, so its owner is never hidden by a missing
 * reason; a park with no reason has nothing to say.
 */
export function HoldCallout({ node }: { node: EngineNode }) {
  if (node.hold !== 'parked' && node.hold !== 'blocked') {
    return null;
  }
  const reason = node.holdReason?.trim() ?? '';
  if (node.hold === 'parked' && reason === '') {
    return null;
  }
  return (
    <div className={cn('rounded-lg p-2.5 text-xs text-ink inset-ring', HOLD_CALLOUT[node.hold])}>
      <span className="microlabel mr-2 text-ink-bright">
        {holdLabel(node.hold, node.blockOwner)}
      </span>
      <LinkifiedText>{reason}</LinkifiedText>
    </div>
  );
}

/** A task in review, awaiting its reviewer's verdict; a container's rollup never is. */
export function awaitsVerdict(node: EngineNode): boolean {
  return node.type === 'task' && node.status === 'under_review';
}

/**
 * The verdict block: the review a task under review carries, shown only while
 * its review is pending. A task in review is work in flight, not a decision
 * the operator owes (ADR 0019), so the block is neutral, not
 * attention-styled. Approve and Send back… sit in the record header, as the
 * state's main action (MMR-726). The submitted-summary line comes from
 * `verdictSummary` (MMR-262); the external ref is the real `externalRef` field.
 */
export function VerdictBlock({
  node,
  annotations,
}: {
  node: EngineNode;
  annotations: readonly NodeAnnotation[] | undefined;
}) {
  const summary = verdictSummary(node.history, annotations);
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-line bg-well-850 p-3.5">
      {/* Labelled Review: the header's status word already names the status (MMR-718). */}
      <p className="microlabel text-ink-dim">Review</p>
      {summary !== undefined && <p className="text-xs leading-relaxed text-ink">{summary}</p>}
      {node.externalRef != null && <ExternalRef value={node.externalRef} />}
    </div>
  );
}

const MAIN_VERBS: Partial<Record<EngineNode['status'], readonly TransitionVerb[]>> = {
  ready: ['start'],
  under_review: ['done', 'return'],
};

/**
 * The verbs a task's header offers as its main action (ADR 0019, MMR-726):
 * Start when it is ready, Approve and Send back… under review, and nothing
 * otherwise, as while an agent runs or the task waits on others. Only a task
 * transitions: a container's status is a rollup of its children.
 */
export function mainVerbs(node: EngineNode): VerbSpec[] {
  if (node.type !== 'task') {
    return [];
  }
  const main = MAIN_VERBS[node.status] ?? [];
  return availableTransitions(node.status).filter((v) => main.includes(v.verb));
}

/** The header's label for a main verb: under review, Mark done reads Approve. */
export function mainVerbLabel(v: VerbSpec): string {
  const label = v.verb === 'done' ? 'Approve' : v.label;
  return v.needsReason ? `${label}…` : label;
}

const HOLD_VERBS: ReadonlySet<TransitionVerb> = new Set(['park', 'block', 'unpark', 'unblock']);

/**
 * The verbs a task's More offers, outside its main action, in More's groups:
 * status changes, then holds, then Abandon on its own.
 */
export function moreVerbs(node: EngineNode): {
  status: VerbSpec[];
  holds: VerbSpec[];
  abandon: VerbSpec[];
} {
  if (node.type !== 'task') {
    return { abandon: [], holds: [], status: [] };
  }
  const main = new Set(mainVerbs(node).map((v) => v.verb));
  const rest = availableTransitions(node.status).filter((v) => !main.has(v.verb));
  return {
    abandon: rest.filter((v) => v.verb === 'abandon'),
    holds: rest.filter((v) => HOLD_VERBS.has(v.verb)),
    status: rest.filter((v) => v.verb !== 'abandon' && !HOLD_VERBS.has(v.verb)),
  };
}

function fromNode(n: EngineNode): TaskFormValues {
  return {
    description: n.description ?? '',
    external_ref: n.externalRef ?? '',
    priority: n.priority ?? '',
    size: n.size ?? '',
    summary: n.summary ?? '',
    // Reparenting is the Move… verb (its own dialog), not the dumb update — the
    // edit form carries no parent picker. Tags are editable here (MMR-257);
    // submit diffs the submitted names against these to fire tag/untag.
    tags: n.tags?.map((t) => t.tag) ?? [],
    title: n.title,
  };
}

/**
 * The edit form's state for one node. `baseline` snapshots the form's initial
 * values when editing begins; non-null means editing. It is also the tag-diff
 * baseline: diffing against live node data would misread a tag added
 * concurrently elsewhere (refetched while the form is open) as a removal.
 */
export function useNodeEdit(nodeId: string) {
  const [baseline, setBaseline] = useState<TaskFormValues | null>(null);
  const update = useUpdateNode(nodeId);
  const tag = useTag(nodeId);
  const untag = useUntag(nodeId);

  // Tags aren't a scalar field on the dumb update — diff the submitted names
  // against the baseline and fire tag/untag per delta. An unchanged tag issues
  // neither: re-issuing `tag` on one that already exists would PUT it with no
  // note, silently dropping any note it carries.
  async function handleSubmit(values: TaskFormSubmit) {
    const currentTags = new Set(baseline?.tags);
    const nextTags = new Set(values.tags);
    const added = [...nextTags].filter((t) => !currentTags.has(t));
    const removed = [...currentTags].filter((t) => !nextTags.has(t));

    try {
      await Promise.all([
        update.mutateAsync({
          description: proseEdit(values.description, baseline?.description),
          externalRef: values.external_ref ?? undefined,
          priority: values.priority ?? undefined,
          size: values.size ?? undefined,
          summary: values.summary ?? undefined,
          title: values.title,
        }),
        ...added.map((t) => tag.mutateAsync(t)),
        ...removed.map((t) => untag.mutateAsync(t)),
      ]);
      setBaseline(null);
    } catch {
      // Each mutation already toasts its own failure (onError in mutations.ts);
      // this just keeps the edit form open instead of closing on a partial fail.
    }
  }

  return {
    baseline,
    begin: (node: EngineNode) => setBaseline(fromNode(node)),
    handleCancel: () => setBaseline(null),
    handleSubmit,
    submitting: update.isPending || tag.isPending || untag.isPending,
  };
}

/**
 * Fire a node's transition verbs: a verb that takes a reason opens the reason
 * dialog first. Render `dialog` once wherever the verbs are offered.
 */
export function useNodeVerbs(nodeId: string) {
  const { mutate: transition } = useTransition(nodeId);
  const [reasonVerb, setReasonVerb] = useState<VerbSpec | null>(null);

  function handleVerb(v: VerbSpec) {
    if (v.needsReason) {
      setReasonVerb(v);
    } else {
      transition({ verb: v.verb });
    }
  }

  const dialog = (
    <Reason
      title={reasonVerb === null ? '' : transitionLabel(reasonVerb.verb)}
      required={reasonVerb?.verb === 'unqueue'}
      open={reasonVerb !== null}
      onClose={() => setReasonVerb(null)}
      commits={[
        {
          label: 'Confirm',
          onCommit: (reason) => {
            if (reasonVerb !== null) {
              transition(
                reason === '' ? { verb: reasonVerb.verb } : { reason, verb: reasonVerb.verb },
              );
            }
          },
        },
      ]}
    />
  );

  return { dialog, handleVerb };
}
