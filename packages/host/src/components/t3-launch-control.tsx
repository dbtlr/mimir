import type { EngineNode } from '@mimir/contract';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { T3Catalog, T3LaunchInput, T3System } from '../api/fns/t3';
import { t3CatalogQuery, t3OriginQuery, useConnectT3, useLaunchT3 } from '../api/t3-queries';
import { cn } from '../lib/cn';
import { projectKeyOf } from '../lib/project-key';
import { newAttempt } from '../lib/t3-attempt';
import {
  defaultsForSystem,
  launchDefaults,
  recallChoice,
  rememberChoice,
} from '../lib/t3-defaults';
import type { LaunchChoice, RememberedChoice } from '../lib/t3-defaults';
import { ActionMenu } from './patterns/action-menu';
import type { ActionMenuEntry } from './patterns/action-menu';
import { toast } from './patterns/notice';
import { announceLaunch } from './t3-launch-answers';
import { T3LaunchForm } from './t3-launch-form';
import { actionButtonVariants, ActionButton } from './ui/action-button';

type ReachableSystem = Extract<T3System, { status: 'reachable' }>;
type Connected = Extract<T3Catalog, { state: 'connected' }>;

/** Where Start is offered and the task can be queued: ready or awaiting (todo, not held). */
export function canLaunchOnT3(node: EngineNode): boolean {
  return node.type === 'task' && (node.status === 'ready' || node.status === 'awaiting');
}

/** What the settings form opens with, and the launch it hands its choice to. */
type SettingsRequest = {
  taskId: string;
  taskTitle: string;
  systems: ReachableSystem[];
  remembered: RememberedChoice | null;
  environmentId?: string;
  run: (choice: LaunchChoice) => void;
  /**
   * The control focus returns to when the form closes: the half of the split
   * button that asked. A menu row that asked is gone by then, so it names its
   * trigger. Once that control is gone too (a phone's Actions sheet closed
   * behind it), focus stays where the page's own handoff puts it.
   */
  opener: () => HTMLElement | null;
};

const OpenSettings = createContext<((request: SettingsRequest) => void) | null>(null);

/** The element when it is still on the page and can take focus, else nothing. */
function usable(element: HTMLElement | null | undefined): HTMLElement | null {
  return element?.isConnected === true &&
    !(element instanceof HTMLButtonElement && element.disabled)
    ? element
    : null;
}

/** The newest element of `trail` still usable: what focus left last that is still there. */
function lastUsable(trail: readonly HTMLElement[]): HTMLElement | null {
  for (let i = trail.length - 1; i >= 0; i -= 1) {
    const found = usable(trail[i]);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/** How many recent focus targets the host keeps. */
const TRAIL_LENGTH = 8;

/**
 * The elements that last took focus, newest last. When the control that asked
 * for the settings is gone by the time the form closes (a phone's Actions
 * sheet closed behind it), focus walks back to the newest one still on the
 * page, as the chip that opened that sheet, never to the page's body.
 */
function useFocusTrail() {
  const trail = useRef<HTMLElement[]>([]);
  useEffect(() => {
    const record = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement) {
        trail.current = [...trail.current, event.target].slice(-TRAIL_LENGTH);
      }
    };
    document.addEventListener('focusin', record);
    return () => {
      document.removeEventListener('focusin', record);
    };
  }, []);
  return trail;
}

/**
 * Holds Launch in T3's settings form above the controls that open it. On a
 * phone the control sits in a record's chip sheet, which closes on the choice
 * and unmounts it, so a form the control held would close with it; one held
 * here outlives that sheet. It closes when the task loses launch eligibility.
 * A control with no host above it makes its own.
 */
export function T3LaunchSettingsHost({
  children,
  eligible = true,
}: {
  children: ReactNode;
  eligible?: boolean;
}) {
  // The request stays through the form's close, so its exit and focus return can run.
  const [request, setRequest] = useState<(SettingsRequest & { id: number }) | null>(null);
  const [open, setOpen] = useState(false);
  const requestId = useRef(0);
  const trail = useFocusTrail();
  const openSettings = useCallback(
    (next: SettingsRequest) => {
      requestId.current += 1;
      // Where focus was on the way here, newest last: the control, the sheet it sat in, the
      // chip that opened that sheet. Read now, before the form takes focus.
      const before = trail.current.slice();
      setRequest({
        ...next,
        id: requestId.current,
        opener: () => next.opener() ?? lastUsable(before),
      });
      setOpen(true);
    },
    [trail],
  );
  if (!eligible && open) {
    setOpen(false);
  }
  return (
    <OpenSettings.Provider value={openSettings}>
      {children}
      {request !== null && (
        <T3LaunchForm
          key={request.id}
          open={eligible && open}
          taskId={request.taskId}
          taskTitle={request.taskTitle}
          systems={request.systems}
          remembered={request.remembered}
          initialEnvironmentId={request.environmentId}
          finalFocus={request.opener}
          onClose={() => {
            setOpen(false);
          }}
          onLaunch={(choice) => {
            setOpen(false);
            request.run(choice);
          }}
        />
      )}
    </OpenSettings.Provider>
  );
}

/**
 * Launch this task in a new T3 thread (ADR 0040, Launch). It shows only when
 * the host has an Open in T3 origin, so an unconfigured console makes no T3
 * call and shows nothing.
 */
export function T3LaunchControl({ node, offline }: { node: EngineNode; offline: boolean }) {
  if (useContext(OpenSettings) === null) {
    return (
      <T3LaunchSettingsHost>
        <T3LaunchControl node={node} offline={offline} />
      </T3LaunchSettingsHost>
    );
  }
  return <LaunchControl node={node} offline={offline} />;
}

function LaunchControl({ node, offline }: { node: EngineNode; offline: boolean }) {
  const origin = useQuery(t3OriginQuery).data?.origin ?? null;
  if (origin === null) {
    return null;
  }
  return <LaunchOnT3 node={node} offline={offline} origin={origin} />;
}

const reachable = (system: T3System): system is ReachableSystem =>
  system.status === 'reachable' && system.projects.length > 0;

function LaunchOnT3({
  node,
  offline,
  origin,
}: {
  node: EngineNode;
  offline: boolean;
  origin: string;
}) {
  const project = projectKeyOf(node.id);
  // T3 is another service, so its catalog is read on mount and on demand, not polled.
  const catalog = useQuery({ ...t3CatalogQuery(project), refetchInterval: false });
  const connect = useConnectT3((answer) => {
    toast.error(
      answer.state === 'misconfigured'
        ? `T3 is not set up: ${answer.setting} is ${answer.problem}.`
        : 'Connect T3 is not available.',
    );
  });
  const launch = useLaunchT3((answer, input, retry) => {
    if (answer.state === 'launched') {
      rememberChoice(project, input);
    }
    announceLaunch(answer, input, { origin, retry });
  });

  // One user-initiated launch: a new attempt, kept for its Retry.
  const run = (choice: LaunchChoice) => {
    const input: T3LaunchInput = { ...choice, attempt: newAttempt(), task: node.id };
    launch.mutate(input);
  };

  if (catalog.data === undefined) {
    return catalog.isError ? (
      <RetryRead onRetry={() => void catalog.refetch()} />
    ) : (
      <ActionButton size="sm" variant="outline" disabled>
        Launch in T3…
      </ActionButton>
    );
  }
  const data = catalog.data;
  if (data.state === 'unconfigured') {
    return null;
  }
  if (data.state === 'misconfigured') {
    return (
      <span className="inline-flex items-center gap-2">
        <ActionButton
          size="sm"
          variant="outline"
          disabled
          title={`T3 is not set up: ${data.setting} is ${data.problem}`}
        >
          Launch in T3…
        </ActionButton>
        <Link to="/settings/connections" className="text-xs text-accent-foreground hover:underline">
          Connections
        </Link>
      </span>
    );
  }
  if (data.state === 'disconnected') {
    return (
      <ActionButton
        size="sm"
        variant="outline"
        disabled={offline || connect.isPending}
        onClick={() => {
          connect.mutate();
        }}
      >
        Reconnect T3
      </ActionButton>
    );
  }
  if (data.state === 'unreachable') {
    return <RetryRead onRetry={() => void catalog.refetch()} />;
  }
  return (
    <ConnectedLaunch
      catalog={data}
      project={project}
      taskId={node.id}
      taskTitle={node.title}
      disabled={offline || launch.isPending}
      onRun={run}
    />
  );
}

/** T3 did not answer the catalog read: the label retries it. */
function RetryRead({ onRetry }: { onRetry: () => void }) {
  return (
    <ActionButton
      size="sm"
      variant="outline"
      title="T3 did not answer. Select to try again."
      onClick={onRetry}
    >
      T3 unreachable
    </ActionButton>
  );
}

function Unavailable({ reason }: { reason: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <ActionButton size="sm" variant="outline" disabled title={reason}>
        Launch in T3…
      </ActionButton>
      <span className="text-tag text-ink-faint">{reason}</span>
    </span>
  );
}

const HALF = 'inset-ring inset-ring-line-bright text-ink hover:bg-line/50 hover:text-ink-bright';


function ConnectedLaunch({
  catalog,
  project,
  taskId,
  taskTitle,
  disabled,
  onRun,
}: {
  catalog: Connected;
  project: string;
  taskId: string;
  taskTitle: string;
  disabled: boolean;
  onRun: (choice: LaunchChoice) => void;
}) {
  const openSettings = useContext(OpenSettings);
  const main = useRef<HTMLButtonElement>(null);
  const caret = useRef<HTMLButtonElement>(null);
  if (catalog.noRemote) {
    return <Unavailable reason="This project has no git remote for T3 to match." />;
  }
  const launchable = catalog.systems.filter(reachable);
  if (launchable.length === 0) {
    return <Unavailable reason="No T3 system has this project." />;
  }
  const remembered = recallChoice(project);
  const defaults = launchDefaults(catalog.systems, remembered);
  const defaultLabel = catalog.systems.find(
    (s) => s.environmentId === defaults?.environmentId,
  )?.label;
  const onSettings = (environmentId: string | undefined, from: 'main' | 'menu') => {
    const returnTo = from === 'main' ? main : caret;
    openSettings?.({
      environmentId,
      opener: () => usable(returnTo.current),
      remembered,
      run: onRun,
      systems: launchable,
      taskId,
      taskTitle,
    });
  };

  return (
    <span className="inline-flex">
      <button
        ref={main}
        type="button"
        disabled={disabled}
        onClick={() => {
          if (defaults === null) {
            onSettings(undefined, 'main');
          } else {
            onRun(defaults);
          }
        }}
        className={cn(actionButtonVariants({ size: 'sm', variant: 'outline' }), 'rounded-r-none')}
      >
        {defaultLabel === undefined ? 'Launch in T3…' : `Launch on ${defaultLabel}`}
      </button>
      <ActionMenu
        title="Launch in T3"
        trigger={
          <button
            ref={caret}
            type="button"
            disabled={disabled}
            aria-label="Choose where to launch"
            className={cn(
              actionButtonVariants({ size: 'sm', variant: 'outline' }),
              HALF,
              'rounded-l-none px-2',
            )}
          >
            <span aria-hidden>▾</span>
          </button>
        }
        entries={[
          ...catalog.systems.map((system): ActionMenuEntry => {
            const choice = defaultsForSystem(system, remembered);
            return {
              disabled: system.status !== 'reachable',
              key: system.environmentId,
              kind: 'action',
              label: `Launch on ${system.label}`,
              onSelect: () => {
                if (choice === null) {
                  onSettings(system.environmentId, 'menu');
                } else {
                  onRun(choice);
                }
              },
            };
          }),
          { key: 'separator', kind: 'separator' },
          {
            key: 'settings',
            kind: 'action',
            label: 'Choose settings…',
            onSelect: () => {
              onSettings(defaults?.environmentId, 'menu');
            },
          },
        ]}
      />
    </span>
  );
}
