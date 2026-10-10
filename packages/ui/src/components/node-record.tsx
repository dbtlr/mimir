import type { NodeRef } from '@mimir/contract';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { useTag, useTransition, useUntag, useUpdateNode } from '../api/mutations';
import type { WireAnnotation, WireArtifact, WireDeps, WireNode, WireTreeNode } from '../api/types';
import { cn } from '../lib/cn';
import { nodeLink } from '../lib/record-url';
import type { TaskFormValues } from '../lib/schemas';
import { availableTransitions, transitionLabel } from '../lib/transitions';
import type { VerbSpec } from '../lib/transitions';
import { verdictSummary } from '../lib/verdict';
import { DistributionBar } from './distribution-bar';
import { ReasonDialog } from './reason-dialog';
import { OpenEndedBadge, PriorityBadge, SizeBadge, StaleBadge } from './signal-badges';
import { StatusDot } from './status-dot';
import type { TaskFormSubmit } from './task-form';
import { ActionButton } from './ui/action-button';
import { Badge } from './ui/badge';

/*
 * The pieces of a work node's record that the record pages and the dossier
 * overlay share: links to other records, the verdict block, the hold callout,
 * detail rows, a container's contents, and the edit and transition wiring.
 */

export function Microlabel({ children }: { children: ReactNode }) {
  return <h3 className="microlabel text-ink-faint">{children}</h3>;
}

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

/**
 * Links to a record's artifacts in the artifact reader. `from` is the work
 * node the reader's "back to" link returns to; a project passes none.
 */
export function ArtifactLinks({
  artifacts,
  from,
}: {
  artifacts?: readonly WireArtifact[];
  from?: string;
}) {
  if (artifacts === undefined || artifacts.length === 0) {
    return <p className="text-xs text-ink-faint">None yet.</p>;
  }
  return (
    <div className="flex flex-col gap-0.5">
      {artifacts.map((a) => (
        <Link
          key={a.id}
          to="/artifacts"
          search={from === undefined ? { a: a.id } : { a: a.id, from }}
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

/**
 * What a project or container holds (MMR-450): one row per child in rank
 * order, each linking to its page. A container child names its kind and
 * carries its rollup bar. `items` is undefined while the tree loads.
 */
export function ContentsSection({ items }: { items: readonly WireTreeNode[] | undefined }) {
  return (
    <section aria-label="Contents" className="flex flex-col gap-1.5">
      <h2 className="microlabel border-b border-line pb-1.5 text-ink-faint">
        Contents{items !== undefined && items.length > 0 && ` · ${String(items.length)}`}
      </h2>
      {items !== undefined && items.length === 0 && (
        <p className="text-xs text-ink-faint">Nothing here yet.</p>
      )}
      {items !== undefined && items.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {items.map((child) => (
            <li key={child.id}>
              <Link
                {...nodeLink(child.id)}
                className="flex min-w-0 items-center gap-2 rounded-sm px-1 py-1 text-xs text-ink transition-colors hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent"
              >
                <StatusDot status={child.status} />
                <span className="shrink-0 font-mono text-mono-id text-accent-foreground">
                  {child.id}
                </span>
                {child.type !== 'task' && (
                  <span className="microlabel shrink-0 text-ink-faint">{child.type}</span>
                )}
                <span className="min-w-0 flex-1 truncate">{child.title}</span>
                {child.type !== 'task' && (
                  <DistributionBar
                    distribution={child.distribution ?? {}}
                    className="hidden h-1 w-[90px] shrink-0 sm:flex"
                  />
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Rows deduped by node id: each keeps its first-seen position and its
 * last-seen reading, so an inherited `awaiting_on` entry refreshes a stale
 * `depends_on` one.
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
export function prerequisiteRows(deps: WireDeps): NodeRef[] {
  return dedupe(deps.depends_on, deps.awaiting_on);
}

/** The dossier's merged Blocking section: prerequisites, then the nodes waiting on this one. */
export function blockingRows(deps: WireDeps): NodeRef[] {
  return dedupe(deps.depends_on, deps.awaiting_on, deps.blocking);
}

/** Does the node carry any signal: open-ended, priority, size, staleness, or tags? */
export function hasSignals(node: WireNode): boolean {
  return (
    node.open_ended === true ||
    node.priority != null ||
    node.size != null ||
    node.verdicts?.stale === true ||
    (node.tags?.length ?? 0) > 0
  );
}

/** A node's signals as badges; render it only when {@link hasSignals} holds. */
export function SignalBadges({ node }: { node: WireNode }) {
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

/** external_ref is free text (e.g. `GH-123`, `PR #41`) — only link genuine URLs. */
function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** external_ref as a `↗` link when it's a URL, else plain mono text (no dead link). */
export function ExternalRef({ value }: { value: string }) {
  if (isHttpUrl(value)) {
    return (
      <a
        href={value}
        target="_blank"
        rel="noreferrer"
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

/** Hold-reason callout wash, keyed to the hold kind (parked ≠ blocked hue). */
const HOLD_CALLOUT: Record<'blocked' | 'parked', { box: string; label: string }> = {
  blocked: {
    box: 'bg-status-blocked/10 inset-ring-status-blocked/24',
    label: 'text-status-blocked',
  },
  parked: {
    box: 'bg-status-parked/10 inset-ring-status-parked/24',
    label: 'text-status-parked',
  },
};

/** The reason a held task gives, when it gives one. */
export function HoldCallout({ node }: { node: WireNode }) {
  if (
    (node.hold !== 'parked' && node.hold !== 'blocked') ||
    node.hold_reason == null ||
    node.hold_reason.trim() === ''
  ) {
    return null;
  }
  return (
    <div
      className={cn('rounded-lg p-2.5 text-xs text-ink inset-ring', HOLD_CALLOUT[node.hold].box)}
    >
      <span className={cn('microlabel mr-2', HOLD_CALLOUT[node.hold].label)}>{node.hold}</span>
      {node.hold_reason}
    </div>
  );
}

/** A task awaiting its reviewer's verdict; a container's rollup never does. */
export function awaitsVerdict(node: WireNode): boolean {
  return node.type === 'task' && node.status === 'under_review';
}

/**
 * The verdict block — shown only while a task's review is pending. Approve fires
 * `done` immediately; Return opens the reason dialog. The submitted-summary
 * line comes from `verdictSummary` (MMR-262), the same derivation the quick
 * view uses; the external ref is the real `external_ref` field.
 */
export function VerdictBlock({
  node,
  annotations,
  offline,
  onVerb,
  heading = false,
}: {
  node: WireNode;
  annotations: readonly WireAnnotation[] | undefined;
  offline?: boolean;
  onVerb: (v: VerbSpec) => void;
  /** Label the block "Needs your verdict", as the record page does. */
  heading?: boolean;
}) {
  const verbs = availableTransitions(node.status);
  const doneSpec = verbs.find((v) => v.verb === 'done');
  const returnSpec = verbs.find((v) => v.verb === 'return');
  const summary = verdictSummary(node.history, annotations);

  return (
    <div className="flex flex-col gap-2.5 rounded-xl bg-gradient-to-br from-attention/10 to-attention/[0.03] p-3.5 inset-ring inset-ring-attention/35">
      {heading && <p className="microlabel text-attention-foreground">Needs your verdict</p>}
      {summary !== undefined && <p className="text-xs leading-relaxed text-ink">{summary}</p>}
      {node.external_ref != null && <ExternalRef value={node.external_ref} />}
      <div className="flex gap-2">
        {doneSpec !== undefined && (
          <ActionButton
            size="sm"
            variant="attention"
            disabled={offline}
            onClick={() => onVerb(doneSpec)}
          >
            Approve
          </ActionButton>
        )}
        {returnSpec !== undefined && (
          <ActionButton
            size="sm"
            variant="outline"
            disabled={offline}
            onClick={() => onVerb(returnSpec)}
          >
            {transitionLabel('return')}…
          </ActionButton>
        )}
      </div>
    </div>
  );
}

/**
 * The transition verbs a node offers outside its verdict block. Only a task
 * transitions: a container's status is a rollup of its children. Under
 * review, Approve and Return live in the verdict block instead.
 */
export function recordVerbs(node: WireNode): VerbSpec[] {
  if (node.type !== 'task') {
    return [];
  }
  return availableTransitions(node.status).filter((v) =>
    node.status === 'under_review' ? v.verb !== 'done' && v.verb !== 'return' : true,
  );
}

function fromNode(n: WireNode): TaskFormValues {
  return {
    description: n.description ?? '',
    external_ref: n.external_ref ?? '',
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
          description: values.description ?? undefined,
          external_ref: values.external_ref ?? undefined,
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
    begin: (node: WireNode) => setBaseline(fromNode(node)),
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
    <ReasonDialog
      verb={reasonVerb?.verb ?? null}
      open={reasonVerb !== null}
      onClose={() => setReasonVerb(null)}
      onConfirm={(reason) => {
        if (reasonVerb !== null) {
          transition(reason === '' ? { verb: reasonVerb.verb } : { reason, verb: reasonVerb.verb });
        }
        setReasonVerb(null);
      }}
    />
  );

  return { dialog, handleVerb };
}
