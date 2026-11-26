import type { EngineNode, NodeRef } from '@mimir/contract';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { useTransition } from '../api/node-mutations';
import { cn } from '../lib/cn';
import { externalRefText, isBareUrl } from '../lib/links';
import { availableTransitions, transitionLabel } from '../lib/transitions';
import type { TransitionVerb, VerbSpec } from '../lib/transitions';
import { MarkdownBody } from './markdown-body';
import { FactMono } from './patterns/facts';
import { Reason } from './patterns/reason';
import { OpenEndedBadge, PriorityBadge, SizeBadge, StaleBadge } from './signal-badges';
import { Badge } from './ui/badge';
import { ExternalIcon } from './ui/icons';

/*
 * The pieces of a work node's record page: its description and signals,
 * detail rows, and the transition wiring.
 */

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
 * An external ref, which is free text (`GH-123`, a URL): a URL as a link that
 * opens in a new tab, named "PR #653" when it is a pull request's, with the
 * external arrow at its text's size; anything else as mono text, so no link
 * goes nowhere. A fact's value passes `FACT_LINK_CLASS`, which sizes it as a
 * link fact.
 */
export function ExternalRef({ value, className }: { value: string; className?: string }) {
  if (!isBareUrl(value)) {
    return <FactMono>{value}</FactMono>;
  }
  return (
    <a
      href={value}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'text-accent-foreground hover:underline focus-visible:outline-2 focus-visible:outline-accent',
        className,
      )}
    >
      {externalRefText(value)}
      <ExternalIcon className="ml-1 inline-block size-[1em] align-[-0.125em]" />
    </a>
  );
}

export function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 text-tag">
      <dt className="text-ink-dim">{label}</dt>
      <dd className="min-w-0 text-right font-mono break-words text-ink">{children}</dd>
    </div>
  );
}

/** A hold's name: a block names who can clear it; a park, or a legacy block without an owner, just the hold. */
export function holdLabel(hold: 'blocked' | 'parked', owner: EngineNode['blockOwner']): string {
  if (hold === 'parked') {
    return 'Parked';
  }
  return owner == null ? 'Blocked' : `Blocked on ${owner}`;
}

const MAIN_VERBS: Partial<Record<EngineNode['status'], readonly TransitionVerb[]>> = {
  ready: ['start'],
  under_review: ['done', 'return'],
};

/**
 * The verbs a task's header offers as its main action (ADR 0019, MMR-726 and
 * MMR-728): Start when it is ready, Approve and Send back… under review,
 * Unblock when it is blocked on you, and nothing otherwise, as while an agent
 * runs or the task waits on others. Only a task transitions: a container's
 * status is a rollup of its children.
 */
export function mainVerbs(node: EngineNode): VerbSpec[] {
  if (node.type !== 'task') {
    return [];
  }
  const main: readonly TransitionVerb[] =
    node.status === 'blocked' && node.blockOwner === 'you'
      ? ['unblock']
      : (MAIN_VERBS[node.status] ?? []);
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
