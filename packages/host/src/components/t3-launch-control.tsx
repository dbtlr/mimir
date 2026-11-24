import type { EngineNode } from '@mimir/contract';
import { useQuery } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';

import type { T3System } from '../api/fns/t3';
import { t3CatalogQuery, t3OriginQuery, useConnectT3, useLaunchT3 } from '../api/t3-queries';
import { projectKeyOf } from '../lib/project-key';
import { newAttempt } from '../lib/t3-attempt';
import {
  defaultsForSystem,
  launchDefaults,
  recallChoice,
  rememberChoice,
} from '../lib/t3-defaults';
import type { LaunchChoice, RememberedChoice } from '../lib/t3-defaults';
import type { ActionMenuAction } from './patterns/action-menu';
import { toast } from './patterns/notice';
import { announceLaunch } from './t3-launch-answers';
import { T3LaunchForm } from './t3-launch-form';

type ReachableSystem = Extract<T3System, { status: 'reachable' }>;

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
 * The elements that last took focus, newest last. The More row that asked for
 * the settings is gone by the time the form closes, with the menu or sheet it
 * sat in, so focus walks back to the newest one still on the page, the More
 * button that opened them, never to the page's body.
 *
 * This stays with T3 rather than in `opener.ts`: the general rule there
 * (`useFinalFocus`) leaves focus to the page's own handoff once the opener is
 * gone (MMR-474). Only this host outlives the menu that held its row, so only
 * it knows a chain of openers to walk back through; another overlay's opener
 * names its own fallback, as Settings › Notifications names a row.
 */
function useFocusTrail(trail: RefObject<HTMLElement[]>) {
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
  }, [trail]);
}

/**
 * Holds Launch in T3's settings form above the More menu that opens it. The
 * menu closes on the choice and unmounts its row, so a form the row held would
 * close with it; one held here outlives the menu. It closes when the task
 * loses launch eligibility.
 */
export function T3LaunchSettingsHost({
  children,
  eligible = true,
}: {
  children: ReactNode;
  eligible?: boolean;
}) {
  // The request stays through the form's close, so its exit and focus return can run.
  const [request, setRequest] = useState<
    (SettingsRequest & { id: number; opener: () => HTMLElement | null }) | null
  >(null);
  const [open, setOpen] = useState(false);
  const requestId = useRef(0);
  const trail = useRef<HTMLElement[]>([]);
  useFocusTrail(trail);
  const openSettings = useCallback((next: SettingsRequest) => {
    requestId.current += 1;
    // Where focus was on the way here, newest last: the row, the menu it sat in, the
    // More button that opened it. Read now, before the form takes focus.
    const before = [...trail.current];
    setRequest({
      ...next,
      id: requestId.current,
      opener: () => lastUsable(before),
    });
    setOpen(true);
  }, []);
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
 * The More rows that start this task in a new T3 thread (ADR 0040, Launch;
 * MMR-726). Once T3 can launch, each catalog system has a one-click "Start on
 * <System>" row, the system the defaults name first: it launches with that
 * system's defaults, or opens the settings form set to it when it has none.
 * "Start in T3…" follows and opens the settings form at the defaults. The rows
 * are offered only where Start is and the host has an Open in T3 origin, so an
 * unconfigured console makes no catalog call and shows none. A state T3 cannot
 * launch from reads as one disabled row that says why, except one the row can
 * mend: a lapsed connection reconnects, and an unanswered catalog read asks
 * again. Call it under a {@link T3LaunchSettingsHost}.
 */
export function useT3LaunchEntries(node: EngineNode, offline: boolean): ActionMenuAction[] {
  const eligible = canLaunchOnT3(node);
  const project = projectKeyOf(node.id);
  const openSettings = useContext(OpenSettings);
  const origin = useQuery({ ...t3OriginQuery, enabled: eligible }).data?.origin ?? null;
  // T3 is another service, so its catalog is read on mount and on demand, not polled.
  const catalog = useQuery({
    ...t3CatalogQuery(project),
    enabled: eligible && origin !== null,
    refetchInterval: false,
  });
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
    if (origin !== null) {
      announceLaunch(answer, input, { origin, retry });
    }
  });
  if (!eligible || origin === null) {
    return [];
  }
  const row: ActionMenuAction = {
    key: 't3-launch',
    kind: 'action',
    label: 'Start in T3…',
  };
  const reread: ActionMenuAction = {
    ...row,
    disabled: offline,
    label: 'T3 unreachable, try again',
    onSelect: () => void catalog.refetch(),
  };
  const data = catalog.data;
  if (data === undefined) {
    return [catalog.isError ? reread : { ...row, disabled: true }];
  }
  switch (data.state) {
    case 'unconfigured': {
      return [];
    }
    case 'misconfigured': {
      return [
        {
          ...row,
          disabled: true,
          label: `Start in T3: ${data.setting} is ${data.problem}`,
        },
      ];
    }
    case 'disconnected': {
      return [
        {
          ...row,
          disabled: offline || connect.isPending,
          label: 'Reconnect T3',
          onSelect: () => {
            connect.mutate();
          },
        },
      ];
    }
    case 'unreachable': {
      return [reread];
    }
    case 'connected': {
      const systems = data.systems.filter(reachable);
      if (data.noRemote) {
        return [
          {
            ...row,
            disabled: true,
            label: 'Start in T3: this project has no git remote',
          },
        ];
      }
      if (systems.length === 0) {
        return [
          {
            ...row,
            disabled: true,
            label: 'Start in T3: no T3 system has this project',
          },
        ];
      }
      const remembered = recallChoice(project);
      const defaults = launchDefaults(data.systems, remembered);
      const busy = offline || launch.isPending;
      const run = (choice: LaunchChoice) => {
        launch.mutate({ ...choice, attempt: newAttempt(), task: node.id });
      };
      const settings = (environmentId: string | undefined) => {
        openSettings?.({
          environmentId,
          remembered,
          run,
          systems,
          taskId: node.id,
          taskTitle: node.title,
        });
      };
      const startOn = (system: T3System): ActionMenuAction => ({
        disabled: busy || !reachable(system),
        key: `t3-start-${system.environmentId}`,
        kind: 'action',
        label: `Start on ${system.label}`,
        onSelect: () => {
          const choice = defaultsForSystem(system, remembered);
          if (choice === null) {
            settings(system.environmentId);
          } else {
            run(choice);
          }
        },
      });
      return [
        ...defaultFirst(data.systems, defaults?.environmentId).map(startOn),
        { ...row, disabled: busy, onSelect: () => settings(defaults?.environmentId) },
      ];
    }
    default: {
      const _exhaustive: never = data;
      return _exhaustive;
    }
  }
}

/** The catalog's systems in order, the one the defaults name moved to the front. */
function defaultFirst(systems: readonly T3System[], environmentId: string | undefined) {
  const first = systems.filter((system) => system.environmentId === environmentId);
  return [...first, ...systems.filter((system) => system.environmentId !== environmentId)];
}

/** A system that can take the launch: reachable, with a project matching this one. */
const reachable = (system: T3System): system is ReachableSystem =>
  system.status === 'reachable' && system.projects.length > 0;
