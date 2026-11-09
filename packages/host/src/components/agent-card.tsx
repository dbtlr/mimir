import type { EngineNode } from '@mimir/contract';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

import { useGroomPanel, useStartGroom } from '../api/agent-queries';
import type { AgentBudgetView, AgentRunView, GroomRefusal } from '../api/fns/agent';
import { deriveAgentCard, formatTokens, refusalText, sharePercent } from '../lib/agent-card';
import type { AgentCardView, ReadyPanel } from '../lib/agent-card';
import { cn } from '../lib/cn';
import { visibleGrooming } from '../lib/grooming';
import { projectKeyOf } from '../lib/project-key';
import { nodeLink } from '../lib/record-url';
import { ago, clockTime } from '../lib/time';
import { StatusDot } from './status-dot';
import { ActionButton } from './ui/action-button';

/*
 * The Groom with agent card on a task's page (ADR 0041, MMR-633): what the
 * agent will do, the page's one solid button, and the day's token budget. The
 * card is absent unless the task shows grooming and the runtime is configured.
 */

const HATCH: CSSProperties = {
  backgroundImage:
    'repeating-linear-gradient(135deg, color-mix(in srgb, var(--color-status-in-progress) 55%, transparent) 0 3px, transparent 3px 6px)',
};

/** A token bar: what is used, then a hatched reservation after it. */
function Meter({
  used,
  reserved = 0,
  total,
  label,
  trailing,
  over = false,
}: {
  used: number;
  reserved?: number;
  total: number;
  label: string;
  trailing?: string;
  over?: boolean;
}) {
  const usedPct = sharePercent(used, total);
  const reservedPct = Math.min(sharePercent(reserved, total), 100 - usedPct);
  return (
    <div className="flex min-w-[200px] flex-1 flex-col gap-1">
      <div
        aria-hidden
        className="relative h-1.5 overflow-hidden rounded-[3px] bg-well-800 inset-ring inset-ring-line"
      >
        <span
          className={cn(
            'absolute inset-y-0 left-0',
            over ? 'bg-status-in-progress/60' : 'bg-accent/55',
          )}
          style={{ width: `${String(usedPct)}%` }}
        />
        <span
          className="absolute inset-y-0"
          style={{
            ...HATCH,
            left: `${String(usedPct)}%`,
            width: `${String(reservedPct)}%`,
          }}
        />
      </div>
      <p className="flex justify-between gap-3 text-meta text-ink-faint">
        <span>{label}</span>
        {trailing !== undefined && <span>{trailing}</span>}
      </p>
    </div>
  );
}

/** The day's budget with this run's reservation, as the ready card shows it. */
function BudgetMeter({ budget, over = false }: { budget: AgentBudgetView; over?: boolean }) {
  return (
    <Meter
      used={budget.usedTokens}
      reserved={budget.runTokens}
      total={budget.dailyTokens}
      over={over}
      label={`${formatTokens(budget.usedTokens)} of ${formatTokens(budget.dailyTokens)} used today · this run reserves ${formatTokens(budget.runTokens)}`}
      trailing={`resets ${clockTime(budget.resetsAt)}`}
    />
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="font-mono text-mono-id text-ink-bright">{children}</code>;
}

/** The card's frame: a header bar with a title (and the model), then the body. */
function Frame({
  title,
  model,
  tone = 'plain',
  dot = false,
  children,
}: {
  title: string;
  model?: string;
  tone?: 'plain' | 'bad';
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      aria-label="Groom with agent"
      className={cn(
        'overflow-hidden rounded-xl border bg-well-850',
        tone === 'bad' ? 'border-status-blocked/30' : 'border-line',
      )}
    >
      <div
        className={cn(
          'flex items-center gap-2 border-b border-line px-4 py-2.5',
          tone === 'bad' ? 'bg-well-950 text-status-blocked-foreground' : 'bg-well-950',
        )}
      >
        {dot && <StatusDot status="in_progress" />}
        <h2 className={cn('microlabel', tone === 'plain' && 'text-ink-faint')}>{title}</h2>
        {model !== undefined && (
          <span className="ml-auto font-mono text-mono-id text-ink-faint">{model}</span>
        )}
      </div>
      <div className="flex flex-col gap-2.5 px-4 py-3 text-xs text-ink-dim">{children}</div>
    </section>
  );
}

function Say({ children }: { children: ReactNode }) {
  return <p className="text-body leading-[1.55] text-ink">{children}</p>;
}

function RunningCard({ run }: { run: AgentRunView }) {
  if (run.stale) {
    return (
      <Frame title="Agent stopped reporting" tone="bad">
        <Say>
          The agent stopped reporting {ago(run.heartbeatAt)}. The host probably restarted mid-run.
          The run is marked interrupted at the next start or boot, and counts its full reservation.
        </Say>
      </Frame>
    );
  }
  return (
    <Frame title="Agent grooming" model={run.model} dot>
      <Say>Reading the code. Notes appear in the timeline as the agent writes them.</Say>
      <p>Started {ago(run.startedAt)}</p>
      <Meter
        used={run.usedTokens}
        total={run.reservedTokens}
        label={`${formatTokens(run.usedTokens)} of its ${formatTokens(run.reservedTokens)} ceiling`}
      />
    </Frame>
  );
}

/** The failed card's title for how the run ended. */
const ENDED_TITLE: Record<AgentRunView['state'], string> = {
  cancelled: 'Last run cancelled',
  failed: 'Last run failed',
  interrupted: 'Last run interrupted',
  running: 'Last run',
  succeeded: 'Last run',
};

type Action = { label: string; solid: boolean; disabled: boolean };

/** The button a state offers, or none. */
function actionFor(view: AgentCardView): Action | undefined {
  switch (view.kind) {
    case 'ready': {
      return { disabled: false, label: 'Groom with agent', solid: true };
    }
    case 'failed': {
      return { disabled: false, label: 'Try again', solid: true };
    }
    case 'groomed':
    case 'answers': {
      return { disabled: false, label: 'Groom again', solid: false };
    }
    case 'busy':
    case 'budget':
    case 'no-remote': {
      return { disabled: true, label: 'Groom with agent', solid: true };
    }
    default: {
      return undefined;
    }
  }
}

function StartButton({
  action,
  busy,
  onStart,
}: {
  action: Action;
  busy: boolean;
  onStart: () => void;
}) {
  return (
    <ActionButton
      size="sm"
      variant={action.solid ? 'action' : 'outline'}
      disabled={action.disabled || busy}
      onClick={onStart}
    >
      {action.label}
    </ActionButton>
  );
}

/** The card body for the states that offer no start: the runtime is off, or the run is live. */
function Passive({
  view,
}: {
  view: Extract<AgentCardView, { kind: 'misconfigured' | 'disconnected' | 'running' }>;
}) {
  switch (view.kind) {
    case 'misconfigured': {
      return (
        <Frame title="Agents not set up" tone="bad">
          <Say>
            <Code>{view.setting}</Code> is {view.problem}, so agent runs stay off. Fix it on the
            host and restart.
          </Say>
        </Frame>
      );
    }
    case 'disconnected': {
      return (
        <Frame title="Agent token refused" tone="bad">
          <Say>
            Anthropic rejected the agent token. Replace the file <Code>MIMIR_AGENT_TOKEN_FILE</Code>{' '}
            names with a fresh <Code>claude setup-token</Code>.
          </Say>
        </Frame>
      );
    }
    default: {
      return <RunningCard run={view.run} />;
    }
  }
}

/** The card body for the states that carry a start button. */
function Active({
  view,
  panel,
  project,
  action,
  busy,
  onStart,
}: {
  view: AgentCardView;
  panel: ReadyPanel;
  project: string;
  action: Action;
  busy: boolean;
  onStart: () => void;
}) {
  const button = <StartButton action={action} busy={busy} onStart={onStart} />;
  switch (view.kind) {
    case 'groomed': {
      return (
        <section
          aria-label="Groom with agent"
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-well-850 px-4 py-2.5 text-xs text-ink-dim"
        >
          <span>
            {view.run === null ? (
              <b className="font-semibold text-ink">Groomed</b>
            ) : (
              <>
                Agent set <b className="font-semibold text-ink">Groomed</b>{' '}
                {ago(view.run.endedAt ?? view.run.startedAt)} · {formatTokens(view.run.usedTokens)}{' '}
                tokens
              </>
            )}
          </span>
          {button}
        </section>
      );
    }
    case 'failed': {
      return (
        <Frame title={ENDED_TITLE[view.run.state]} tone="bad">
          <Say>
            {view.run.outcome ?? 'The run ended without an outcome.'}{' '}
            <span className="text-ink-faint">{ago(view.run.endedAt ?? view.run.startedAt)}</span>
          </Say>
          <div className="flex items-center gap-3">{button}</div>
        </Frame>
      );
    }
    case 'answers': {
      return (
        <Frame title="Agent has a question" model={panel.model}>
          <Say>
            The agent stopped on a question; its question and recommended answer are in the
            timeline.
          </Say>
          <div className="flex items-center gap-3">{button}</div>
        </Frame>
      );
    }
    case 'busy': {
      return (
        <Frame title="Another run is going">
          <Say>
            Agents run one at a time. An agent has been grooming{' '}
            <Link
              {...nodeLink(view.run.task)}
              className="text-accent-foreground hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
            >
              {view.run.task}
            </Link>{' '}
            since {ago(view.run.startedAt)}.
          </Say>
          <div className="flex items-center gap-3">{button}</div>
        </Frame>
      );
    }
    case 'no-remote': {
      return (
        <Frame title="No code to read">
          <Say>
            The agent reads the project&apos;s code from its remote, and {project} has none. Add a
            remote in the project&apos;s settings.
          </Say>
          <div className="flex items-center gap-3">{button}</div>
        </Frame>
      );
    }
    case 'budget': {
      return (
        <Frame title="Daily budget reached">
          <Say>
            A run reserves {formatTokens(panel.budget.runTokens)} tokens and only{' '}
            {formatTokens(panel.budget.remainingTokens)} are left today. The budget resets at{' '}
            {clockTime(panel.budget.resetsAt)}.
          </Say>
          <BudgetMeter budget={panel.budget} over />
          <div className="flex items-center gap-3">{button}</div>
        </Frame>
      );
    }
    default: {
      return (
        <Frame title="Groom with agent" model={panel.model}>
          <Say>
            An agent reads this task and the project&apos;s code, writes what it finds as notes, and
            sets grooming. If it stops on a question, it leaves a recommended answer. It never
            changes status.
          </Say>
          <div className="flex flex-wrap items-center gap-3">
            {button}
            <BudgetMeter budget={panel.budget} />
          </div>
          <p className="text-tag text-ink-faint">
            Token file updated {ago(panel.tokenModifiedAt)}. A setup-token token lasts one year.
          </p>
        </Frame>
      );
    }
  }
}

/** The Groom with agent card, or nothing when the task shows no grooming or the runtime is off. */
export function GroomWithAgentCard({ node, offline }: { node: EngineNode; offline: boolean }) {
  const project = projectKeyOf(node.id);
  const grooming = visibleGrooming(node);
  const panel = useGroomPanel(project, node.id, grooming !== undefined);
  const [refusal, setRefusal] = useState<GroomRefusal | undefined>();
  const start = useStartGroom(setRefusal);
  const data = panel.data;
  if (grooming === undefined || data === undefined || data.state === 'unconfigured') {
    return null;
  }
  const view = deriveAgentCard(data, node.id, grooming);
  const action = actionFor(view);
  const alert = refusal !== undefined && (
    <p
      role="alert"
      className="rounded-xl border border-status-blocked/30 px-4 py-2.5 text-xs text-status-blocked-foreground"
    >
      {refusalText(refusal)}
    </p>
  );
  const body =
    view.kind === 'misconfigured' || view.kind === 'disconnected' || view.kind === 'running' ? (
      <Passive view={view} />
    ) : (
      data.state === 'ready' &&
      action !== undefined && (
        <Active
          view={view}
          panel={data}
          project={project}
          action={action}
          busy={start.isPending || offline}
          onStart={() => {
            setRefusal(undefined);
            start.mutate({ project, task: node.id });
          }}
        />
      )
    );
  return (
    <div className="flex flex-col gap-2">
      {body}
      {alert}
    </div>
  );
}
