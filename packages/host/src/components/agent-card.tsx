import type { EngineNode } from '@mimir/contract';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

import { useGroomCard, useStartGroom } from '../api/agent-queries';
import type { AgentBudgetView, AgentRunView, GroomRefusal } from '../api/fns/agent';
import {
  deriveAgentCard,
  formatTokens,
  refusalText,
  resetText,
  sharePercent,
} from '../lib/agent-card';
import type { AgentCardView, ReadyCard } from '../lib/agent-card';
import { cn } from '../lib/cn';
import { visibleGrooming } from '../lib/grooming';
import { projectKeyOf } from '../lib/project-key';
import { nodeLink } from '../lib/record-url';
import { ago } from '../lib/time';
import { StatusDot } from './status-dot';
import { StopRunDialog } from './stop-run-dialog';
import type { StopTarget } from './stop-run-dialog';
import { ActionButton } from './ui/action-button';

/*
 * The Groom with agent card on a task's page (ADR 0041, MMR-633): what the
 * agent will do, the page's one solid button, and the day's token budget. The
 * card shows only on a task that shows grooming (a todo task). It is absent
 * while agent runs are unconfigured; when they are set up wrongly, the token
 * was refused, or managed settings are on the host, it says what is wrong.
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
      trailing={`resets ${resetText(budget.resetsAt, budget.timezone)}`}
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
  action,
  tone = 'plain',
  dot = false,
  children,
}: {
  title: string;
  model?: string;
  /** A control in the header bar, after the model. */
  action?: ReactNode;
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
        {action}
      </div>
      <div className="flex flex-col gap-2.5 px-4 py-3 text-xs text-ink-dim">{children}</div>
    </section>
  );
}

function Say({ children }: { children: ReactNode }) {
  return <p className="text-body leading-[1.55] text-ink">{children}</p>;
}

/** The token file's age, since a setup-token token lasts one year. */
function TokenAge({ modifiedAt }: { modifiedAt: Date }) {
  return (
    <p className="text-tag text-ink-faint">
      Token file updated {ago(modifiedAt)}. A setup-token token lasts one year.
    </p>
  );
}

/** The live run's card: Stop while the run can be stopped, and "Stopping" once a cancel is recorded. */
function RunningCard({ run, onStop }: { run: AgentRunView; onStop: (target: StopTarget) => void }) {
  return (
    <Frame
      title={run.stopping ? 'Stopping the agent' : 'Agent grooming'}
      model={run.model}
      dot
      action={
        run.cancellable && (
          <ActionButton
            size="sm"
            variant="destructiveOutline"
            className="py-1"
            onClick={() => {
              onStop({ runId: run.id, task: run.task, usedTokens: run.usedTokens });
            }}
          >
            Stop
          </ActionButton>
        )
      }
    >
      <Say>
        {run.stopping
          ? 'Stopping after its current step. This usually takes seconds, and at most 5 minutes.'
          : 'Reading the code. Notes appear in the timeline as the agent writes them.'}
      </Say>
      <p>Started {ago(run.startedAt)}</p>
      <Meter
        used={run.usedTokens}
        total={run.reservedTokens}
        label={`${formatTokens(run.usedTokens)} of its ${formatTokens(run.reservedTokens)} ceiling`}
      />
    </Frame>
  );
}

/**
 * What a run the operator stopped from the console ended on: what else its
 * outcome says, and what today counts for it, which is its reservation when
 * it ended without a usage total.
 */
function StoppedRun({ run }: { run: AgentRunView }) {
  const used = formatTokens(run.usedTokens);
  return (
    <>
      <Say>
        You stopped this run {ago(run.endedAt ?? run.startedAt)}. Its notes stay on the task.
      </Say>
      {run.stopDetail !== null && <p className="text-meta text-ink-faint">{run.stopDetail}</p>}
      <p>
        {run.chargedTokens === run.usedTokens
          ? `Used ${used} tokens, counted toward today.`
          : `Used ${used} tokens. Today counts ${formatTokens(run.chargedTokens)}, its reservation, since it ended without a usage total.`}
      </p>
    </>
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
    case 'failed':
    case 'stale': {
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

/** The card states that offer no start: the runtime is off or blocked, or the run is live. */
type PassiveView = Extract<
  AgentCardView,
  { kind: 'misconfigured' | 'disconnected' | 'managed-policy' | 'running' }
>;

const isPassive = (view: AgentCardView): view is PassiveView =>
  view.kind === 'misconfigured' ||
  view.kind === 'disconnected' ||
  view.kind === 'managed-policy' ||
  view.kind === 'running';

/** The card body for the states that offer no start. */
function Passive({ view, onStop }: { view: PassiveView; onStop: (target: StopTarget) => void }) {
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
          <TokenAge modifiedAt={view.tokenModifiedAt} />
        </Frame>
      );
    }
    case 'managed-policy': {
      return (
        <Frame title="Managed settings on the host" tone="bad">
          <Say>
            Claude Code managed settings exist on the host and would override the run&rsquo;s
            limits, so agent runs stay off. Remove them to run agents:
          </Say>
          <ul className="flex flex-col gap-0.5">
            {view.paths.map((path) => (
              <li key={path}>
                <Code>{path}</Code>
              </li>
            ))}
          </ul>
        </Frame>
      );
    }
    default: {
      return <RunningCard run={view.run} onStop={onStop} />;
    }
  }
}

/** The card body for the states that carry a start button. */
function Active({
  view,
  card,
  project,
  action,
  busy,
  onStart,
}: {
  view: AgentCardView;
  card: ReadyCard;
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
            <b className="font-semibold text-ink">Groomed</b>
            {view.run !== null && (
              <>
                {' '}
                · last agent run {ago(view.run.endedAt ?? view.run.startedAt)} ·{' '}
                {formatTokens(view.run.usedTokens)} tokens
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
          {view.run.stoppedFromConsole ? (
            <StoppedRun run={view.run} />
          ) : (
            <Say>
              {view.run.outcome ?? 'The run ended without an outcome.'}{' '}
              <span className="text-ink-faint">{ago(view.run.endedAt ?? view.run.startedAt)}</span>
            </Say>
          )}
          <div className="flex items-center gap-3">{button}</div>
        </Frame>
      );
    }
    case 'answers': {
      return (
        <Frame title="Groom with agent" model={card.model}>
          <Say>
            Needs answers. The last agent run ended {ago(view.run.endedAt ?? view.run.startedAt)};
            its notes are in the timeline.
          </Say>
          <div className="flex items-center gap-3">{button}</div>
        </Frame>
      );
    }
    case 'stale': {
      return (
        <Frame title="Agent stopped reporting" tone="bad">
          <Say>
            The agent stopped reporting {ago(view.run.heartbeatAt)}. The host probably restarted
            mid-run. A new start marks it interrupted; it counts its reservation or its streamed
            usage, whichever is larger.
          </Say>
          <div className="flex items-center gap-3">{button}</div>
        </Frame>
      );
    }
    case 'busy': {
      return (
        <Frame title="Another run is going">
          <Say>
            Agents run one at a time. An agent started grooming{' '}
            <Link
              {...nodeLink(view.run.task)}
              className="text-accent-foreground hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
            >
              {view.run.task}
            </Link>{' '}
            {ago(view.run.startedAt)}.
          </Say>
          <div className="flex items-center gap-3">{button}</div>
        </Frame>
      );
    }
    case 'no-remote': {
      return (
        <Frame title="No code to read">
          <Say>
            The agent reads the project&apos;s code from its remote, and {project} has none. Set one
            with{' '}
            <code className="font-mono text-mono-id">
              mimir update {project} --remote &lt;url&gt;
            </code>
            .
          </Say>
          <div className="flex items-center gap-3">{button}</div>
        </Frame>
      );
    }
    case 'budget': {
      return (
        <Frame title="Daily budget reached">
          <Say>
            A run reserves {formatTokens(card.budget.runTokens)} tokens and only{' '}
            {formatTokens(card.budget.remainingTokens)} are left today. The budget resets at{' '}
            {resetText(card.budget.resetsAt, card.budget.timezone)}.
          </Say>
          <BudgetMeter budget={card.budget} over />
          <div className="flex items-center gap-3">{button}</div>
        </Frame>
      );
    }
    default: {
      return (
        <Frame title="Groom with agent" model={card.model}>
          <Say>
            An agent reads this task and the project&apos;s code, writes what it finds as notes, and
            sets grooming. If it stops on a question, it leaves a recommended answer. It never
            changes status.
          </Say>
          <div className="flex flex-wrap items-center gap-3">
            {button}
            <BudgetMeter budget={card.budget} />
          </div>
          <TokenAge modifiedAt={card.tokenModifiedAt} />
        </Frame>
      );
    }
  }
}

/** The Groom with agent card, or nothing when the task shows no grooming or agent runs are unconfigured. */
export function GroomWithAgentCard({ node, offline }: { node: EngineNode; offline: boolean }) {
  const project = projectKeyOf(node.id);
  const grooming = visibleGrooming(node);
  const read = useGroomCard(project, node.id, grooming !== undefined);
  const [refusal, setRefusal] = useState<GroomRefusal | undefined>();
  const [stopping, setStopping] = useState<StopTarget | null>(null);
  const start = useStartGroom(setRefusal);
  const data = read.data;
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
  const body = isPassive(view) ? (
    <Passive view={view} onStop={setStopping} />
  ) : (
    data.state === 'ready' &&
    action !== undefined && (
      <Active
        view={view}
        card={data}
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
      {stopping !== null && (
        <StopRunDialog
          target={stopping}
          onClose={() => {
            setStopping(null);
          }}
        />
      )}
    </div>
  );
}
