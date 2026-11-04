import { Menu } from '@base-ui-components/react/menu';
import type { EngineNode } from '@mimir/contract';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';

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
import type { LaunchChoice } from '../lib/t3-defaults';
import { announceLaunch } from './t3-launch-answers';
import { T3LaunchDialog } from './t3-launch-dialog';
import { actionButtonVariants, ActionButton } from './ui/action-button';
import { MenuContent, MenuItem, MenuRoot, MenuTrigger } from './ui/menu';

type ReachableSystem = Extract<T3System, { status: 'reachable' }>;
type Connected = Extract<T3Catalog, { state: 'connected' }>;

/** Where Start is offered and the task can be queued: ready or awaiting (todo, not held). */
export function canLaunchOnT3(node: EngineNode): boolean {
  return node.type === 'task' && (node.status === 'ready' || node.status === 'awaiting');
}

/**
 * Launch this task in a new T3 thread (ADR 0040, Launch). It shows only when
 * the host has an Open in T3 origin, so an unconfigured console makes no T3
 * call and shows nothing.
 */
export function T3LaunchControl({ node, offline }: { node: EngineNode; offline: boolean }) {
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
  const [settings, setSettings] = useState<{ environmentId?: string } | null>(null);

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
        <Link to="/devices" className="text-xs text-accent-foreground hover:underline">
          Devices
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
      disabled={offline || launch.isPending}
      settings={settings}
      onSettings={setSettings}
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
  disabled,
  settings,
  onSettings,
  onRun,
}: {
  catalog: Connected;
  project: string;
  taskId: string;
  disabled: boolean;
  settings: { environmentId?: string } | null;
  onSettings: (next: { environmentId?: string } | null) => void;
  onRun: (choice: LaunchChoice) => void;
}) {
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

  return (
    <>
      <span className="inline-flex">
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            if (defaults === null) {
              onSettings({});
            } else {
              onRun(defaults);
            }
          }}
          className={cn(actionButtonVariants({ size: 'sm', variant: 'outline' }), 'rounded-r-none')}
        >
          {defaultLabel === undefined ? 'Launch in T3…' : `Launch on ${defaultLabel}`}
        </button>
        <MenuRoot>
          <MenuTrigger
            disabled={disabled}
            aria-label="Choose where to launch"
            className={cn(
              actionButtonVariants({ size: 'sm', variant: 'outline' }),
              HALF,
              'rounded-l-none px-2',
            )}
          >
            <span aria-hidden>▾</span>
          </MenuTrigger>
          <MenuContent>
            {catalog.systems.map((system) => (
              <MenuItem
                key={system.environmentId}
                disabled={system.status !== 'reachable'}
                onClick={() => {
                  const choice = defaultsForSystem(system, remembered);
                  if (choice === null) {
                    onSettings({ environmentId: system.environmentId });
                  } else {
                    onRun(choice);
                  }
                }}
              >
                Launch on {system.label}
              </MenuItem>
            ))}
            <Menu.Separator className="mx-0.5 my-1 h-px bg-line" />
            <MenuItem
              onClick={() => {
                onSettings({ environmentId: defaults?.environmentId });
              }}
            >
              Choose settings…
            </MenuItem>
          </MenuContent>
        </MenuRoot>
      </span>
      {settings !== null && (
        <T3LaunchDialog
          taskId={taskId}
          systems={launchable}
          remembered={remembered}
          initialEnvironmentId={settings.environmentId}
          onClose={() => {
            onSettings(null);
          }}
          onLaunch={(choice) => {
            onSettings(null);
            onRun(choice);
          }}
        />
      )}
    </>
  );
}
