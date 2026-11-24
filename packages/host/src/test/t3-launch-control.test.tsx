import { QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { connectT3, launchT3, t3Catalog, t3Origin } from '../api/fns/t3';
import type { T3Catalog, T3LaunchResult } from '../api/fns/t3';
import { ActionMenu } from '../components/patterns/action-menu';
import { toast } from '../components/patterns/notice';
import {
  canLaunchOnT3,
  T3LaunchSettingsHost,
  useT3LaunchEntry,
} from '../components/t3-launch-control';
import { T3LaunchForm } from '../components/t3-launch-form';
import { T3_ATTEMPT_PATTERN } from '../server/t3-states';
import { engineTask } from './node-fixtures';
import { renderInRouter } from './router';
import { connectedCatalog, reachableSystem, unreachableSystem } from './t3-fixtures';
import { serveT3Launch } from './t3-fns';
import { stubViewport } from './viewport';

vi.mock('../api/fns/t3');
vi.mock('../lib/leave-for');
vi.mock('../components/patterns/notice', () => ({
  NoticeHost: () => null,
  toast: { error: vi.fn(), success: vi.fn() },
}));

const task = engineTask({ id: 'MMR-9', status: 'ready', title: 'Launch from the console' });
const LAUNCHED: T3LaunchResult = {
  environmentId: 'env-1',
  label: 'Valhalla',
  state: 'launched',
  threadId: 'thread-1',
};
const DEFAULT_INPUT = {
  environmentId: 'env-1',
  interactionMode: 'default',
  model: { instanceId: 'claude', model: 'opus', options: [{ id: 'effort', value: 'high' }] },
  projectId: 'proj-1',
  runtimeMode: 'full-access',
  task: 'MMR-9',
  workspace: { type: 'worktree' },
};

beforeEach(() => {
  localStorage.clear();
  // A desktop, so the caret opens as a menu; the phone sheet has its own test below.
  stubViewport('desktop');
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/** More with the one row the hook gives, as a task page holds it. */
function LaunchMenu({ offline }: { offline: boolean }) {
  const entry = useT3LaunchEntry(task, offline);
  return (
    <ActionMenu
      title="Launch from the console"
      trigger={<button type="button">More</button>}
      entries={entry === undefined ? [] : [entry]}
    />
  );
}

function renderMenu(offline = false) {
  return renderInRouter(
    <T3LaunchSettingsHost>
      <LaunchMenu offline={offline} />
    </T3LaunchSettingsHost>,
    new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
}

async function show(catalog: T3Catalog, launch?: T3LaunchResult, offline = false) {
  serveT3Launch(catalog, launch);
  return renderMenu(offline);
}

/** Open More and find its row named `name`. */
async function moreRow(name: string | RegExp) {
  await userEvent.click(await screen.findByRole('button', { name: 'More' }));
  return screen.findByRole('menuitem', { name });
}

const launchCalls = () => vi.mocked(launchT3).mock.calls.map(([options]) => options.data);

/**
 * The settings form: the Form sheet titled "Launch in T3", which names the task in its context
 * line (MMR-743). The phone's caret sheet shares the title, so the task tells them apart.
 */
const settingsForm = (taskId = 'MMR-9') =>
  screen.findByRole('dialog', { description: new RegExp(taskId), name: 'Launch in T3' });

/** Choose `option` in the form's Select named `name` (a UI SDK Select, not a native one). */
async function choose(dialog: HTMLElement, name: string, option: string) {
  await userEvent.click(within(dialog).getByRole('combobox', { name }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

/** The options a form's Select named `name` offers, read with its list open. */
async function optionsOf(dialog: HTMLElement, name: string) {
  await userEvent.click(within(dialog).getByRole('combobox', { name }));
  const list = await screen.findByRole('listbox');
  return list;
}

/** The action a toast offered, by label. */
function toastAction(fn: typeof toast.error | typeof toast.success, label: string) {
  const options = vi.mocked(fn).mock.lastCall?.[1] as {
    action?: { label: string; onClick: () => void };
    cancel?: { label: string; onClick: () => void };
  };
  return [options.action, options.cancel].find((action) => action?.label === label);
}

describe('who is offered the launch', () => {
  it.each([
    ['ready', {}, true],
    ['awaiting', {}, true],
    ['queued', {}, false],
    ['in_progress', {}, false],
    ['under_review', {}, false],
    ['parked', { hold: 'parked' as const }, false],
    ['blocked', { hold: 'blocked' as const }, false],
    ['done', {}, false],
  ])('%s: %s', (status, extra, offered) => {
    expect(canLaunchOnT3(engineTask({ status: status as never, ...extra }))).toBe(offered);
  });
});

describe('the Start in T3… row (ADR 0040, MMR-726)', () => {
  it('is absent, and the catalog never read, while T3 is unconfigured', async () => {
    serveT3Launch(connectedCatalog([reachableSystem()]), undefined, null);
    await renderMenu();
    await waitFor(() => {
      expect(t3Origin).toHaveBeenCalled();
    });
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.queryByRole('menuitem')).toBeNull();
    expect(t3Catalog).not.toHaveBeenCalled();
  });

  it('is disabled while the catalog loads', async () => {
    serveT3Launch(connectedCatalog([]));
    vi.mocked(t3Catalog).mockReturnValue(Promise.withResolvers<T3Catalog>().promise);
    await renderMenu();
    await waitFor(() => {
      expect(t3Catalog).toHaveBeenCalled();
    });
    await expect(moreRow('Start in T3…')).resolves.toHaveAttribute('aria-disabled', 'true');
  });

  it('names the setting when T3 is misconfigured, and is disabled', async () => {
    await show({ problem: 'not HTTPS', setting: 'MIMIR_URL', state: 'misconfigured' });
    await waitFor(() => {
      expect(t3Catalog).toHaveBeenCalled();
    });
    await expect(moreRow('Start in T3: MIMIR_URL is not HTTPS')).resolves.toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('offers Reconnect T3 when disconnected, and Reconnect starts Connect', async () => {
    vi.mocked(connectT3).mockResolvedValue({ state: 'unreachable' });
    await show({ reason: 'expired', state: 'disconnected' });
    await waitFor(() => {
      expect(t3Catalog).toHaveBeenCalled();
    });
    await userEvent.click(await moreRow('Reconnect T3'));
    await waitFor(() => {
      expect(connectT3).toHaveBeenCalledOnce();
    });
  });

  it('says T3 is unreachable and rereads the catalog on select', async () => {
    await show({ state: 'unreachable' });
    await waitFor(() => {
      expect(t3Catalog).toHaveBeenCalled();
    });
    await userEvent.click(await moreRow('T3 unreachable, try again'));
    await waitFor(() => {
      expect(t3Catalog).toHaveBeenCalledTimes(2);
    });
  });

  it('reads a failed catalog request as unreachable', async () => {
    serveT3Launch(connectedCatalog([]));
    vi.mocked(t3Catalog).mockRejectedValue(new Error('down'));
    await renderMenu();
    await waitFor(() => {
      expect(t3Catalog).toHaveBeenCalled();
    });
    await expect(moreRow('T3 unreachable, try again')).resolves.not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it.each([
    ['a project with no git remote', connectedCatalog([], true), /no git remote/i],
    ['no system with the project', connectedCatalog([]), /no T3 system/i],
    [
      'only unreachable systems',
      connectedCatalog([unreachableSystem('a', 'asgard')]),
      /no T3 system/i,
    ],
  ])('is disabled with a reason for %s', async (_name, catalog, reason) => {
    await show(catalog);
    await waitFor(() => {
      expect(t3Catalog).toHaveBeenCalled();
    });
    await expect(moreRow(reason)).resolves.toHaveAttribute('aria-disabled', 'true');
  });

  it('is disabled while offline', async () => {
    await show(connectedCatalog([reachableSystem()]), undefined, true);
    await waitFor(() => {
      expect(t3Catalog).toHaveBeenCalled();
    });
    await expect(moreRow('Start in T3…')).resolves.toHaveAttribute('aria-disabled', 'true');
  });

  it('opens the settings at the defaults, and Launch sends them with a fresh attempt', async () => {
    await show(connectedCatalog([reachableSystem()]));
    const dialog = await openSettings();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Launch' }));
    await waitFor(() => {
      expect(launchT3).toHaveBeenCalledOnce();
    });
    const [input] = launchCalls();
    expect(input).toEqual({ ...DEFAULT_INPUT, attempt: expect.stringMatching(T3_ATTEMPT_PATTERN) });
  });

  it('on a phone, sits in the More sheet and opens the same settings', async () => {
    stubViewport('phone');
    await show(connectedCatalog([reachableSystem()]));
    await waitFor(() => {
      expect(t3Catalog).toHaveBeenCalled();
    });
    await userEvent.click(await screen.findByRole('button', { name: 'More' }));
    const sheet = await screen.findByRole('dialog', { name: 'Launch from the console' });
    expect(screen.queryByRole('menu')).toBeNull();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Start in T3…' }));
    await expect(settingsForm()).resolves.toBeInTheDocument();
  });
});

async function openSettings() {
  await waitFor(() => {
    expect(t3Catalog).toHaveBeenCalled();
  });
  await userEvent.click(await moreRow('Start in T3…'));
  return settingsForm();
}

describe('the settings dialog', () => {
  it('clamps a long task title independently of its task ID', () => {
    stubViewport('phone');
    const taskTitle = 'A long task title that takes up too much of the header on a narrow screen';
    render(
      <T3LaunchForm
        open
        taskId="MMR-9"
        taskTitle={taskTitle}
        systems={[reachableSystem()]}
        remembered={null}
        onLaunch={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Launch in T3' });
    expect(within(dialog).getByText(taskTitle)).toHaveClass('line-clamp-2');
    expect(within(dialog).getByText('MMR-9')).not.toHaveClass('line-clamp-2');
  });

  it('with no defaults, starts on the configured server even when a peer is listed first', async () => {
    const projects = [{ defaultModelSelection: null, id: 'proj-1', title: 'mimir' }];
    const peer = reachableSystem({
      configured: false,
      environmentId: 'peer',
      label: 'asgard',
      projects,
    });
    await show(connectedCatalog([peer, reachableSystem({ projects })]));
    const dialog = await openSettings();
    expect(within(dialog).getByRole('combobox', { name: 'System' })).toHaveTextContent('Valhalla');
  });

  it('starts from the defaults and launches the chosen input', async () => {
    await show(connectedCatalog([reachableSystem()]));
    const dialog = await openSettings();
    expect(within(dialog).queryByRole('combobox', { name: 'Project' })).toBeNull();
    expect(within(dialog).getByRole('combobox', { name: 'Model' })).toHaveTextContent(
      'Claude Opus',
    );
    expect(within(dialog).getByRole('radio', { name: 'high' })).toBeChecked();

    await userEvent.click(within(dialog).getByRole('radio', { name: 'low' }));
    const thinking = within(dialog).getByRole('radiogroup', { name: 'Thinking' });
    await userEvent.click(within(thinking).getByRole('radio', { name: 'On' }));
    await choose(dialog, 'Runtime', 'Approval required');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Advanced' }));
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Project checkout' }));
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Plan first' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Launch' }));

    await waitFor(() => {
      expect(launchT3).toHaveBeenCalledOnce();
    });
    expect(launchCalls()[0]).toEqual({
      ...DEFAULT_INPUT,
      attempt: expect.stringMatching(T3_ATTEMPT_PATTERN),
      interactionMode: 'plan',
      model: {
        instanceId: 'claude',
        model: 'opus',
        options: [
          { id: 'effort', value: 'low' },
          { id: 'thinking', value: true },
        ],
      },
      runtimeMode: 'approval-required',
      workspace: { type: 'root' },
    });
  });

  it('labels options in words, and offers Unset only for an option with no usable default', async () => {
    const system = reachableSystem();
    const opus = {
      id: 'opus',
      label: 'Claude Opus',
      options: [
        { default: 'default', id: 'serviceTier', values: ['default', 'priority'] },
        { default: null, id: 'reasoningEffort', values: ['low', 'high'] },
      ],
    };
    const claude = system.providers[0]!;
    await show(connectedCatalog([{ ...system, providers: [{ ...claude, models: [opus] }] }]));
    const dialog = await openSettings();
    const tier = within(dialog).getByRole('radiogroup', { name: 'Service tier' });
    expect(
      within(tier)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['default', 'priority']);
    expect(within(tier).getByRole('radio', { name: 'default' })).toBeChecked();
    const effort = within(dialog).getByRole('radiogroup', { name: 'Reasoning effort' });
    expect(within(effort).getByRole('radio', { name: 'Unset' })).toBeChecked();
  });

  it.each([
    ['a long label', { default: null, values: ['low', 'maximum reasoning depth'] }],
    ['five displayed choices', { default: null, values: ['low', 'med', 'high', 'max'] }],
    ['five one-letter choices', { default: null, values: ['a', 'b', 'c', 'd'] }],
    ['a short label of two words', { default: null, values: ['low', 'a b'] }],
    ['a nine-letter label beside Unset', { default: null, values: ['ninechars'] }],
    ['a seven-letter label among three choices', { default: null, values: ['low', 'sevench'] }],
  ])('uses a Select for %s and segments for four short labels', async (_, option) => {
    const system = reachableSystem();
    const claude = system.providers[0]!;
    const opus = {
      id: 'opus',
      label: 'Claude Opus',
      options: [
        { default: 'low', id: 'effort', values: ['low', 'med', 'high', 'max'] },
        { id: 'reasoningBudget', ...option },
      ],
    };
    await show(connectedCatalog([{ ...system, providers: [{ ...claude, models: [opus] }] }]));
    const dialog = await openSettings();
    const effort = within(dialog).getByRole('radiogroup', { name: 'Effort' });
    expect(within(effort).getAllByRole('radio')).toHaveLength(4);
    expect(within(effort).getByRole('radio', { name: 'low' })).toBeChecked();

    const select = within(dialog).getByRole('combobox', { name: 'Reasoning budget' });
    expect(select).toHaveTextContent('Unset');
    await choose(dialog, 'Reasoning budget', option.values.at(-1)!);
    expect(select).toHaveTextContent(option.values.at(-1)!);
    await choose(dialog, 'Reasoning budget', 'Unset');
    expect(select).toHaveTextContent('Unset');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Launch' }));

    await waitFor(() => {
      expect(launchCalls()[0]?.model.options).toEqual([{ id: 'effort', value: 'low' }]);
    });
  });

  it('can set a boolean option off or on and then omit it again', async () => {
    await show(connectedCatalog([reachableSystem()]));
    const dialog = await openSettings();
    const thinking = within(within(dialog).getByRole('radiogroup', { name: 'Thinking' }));
    const unset = thinking.getByRole('radio', { name: 'Unset' });
    expect(unset).toBeChecked();
    for (const name of ['On', 'Off']) {
      const option = thinking.getByRole('radio', { name });
      await userEvent.click(option);
      expect(option).toBeChecked();
    }
    await userEvent.click(unset);
    expect(unset).toBeChecked();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Launch' }));
    await waitFor(() => {
      expect(launchT3).toHaveBeenCalledOnce();
    });
    expect(launchCalls()[0]?.model.options).toEqual([{ id: 'effort', value: 'high' }]);
  });

  it('uses a checkbox for a boolean option with a usable default', async () => {
    const system = reachableSystem();
    const [provider] = system.providers;
    if (provider === undefined) {
      throw new Error('the system fixture has no provider');
    }
    const opus = {
      id: 'opus',
      label: 'Claude Opus',
      options: [{ default: true, id: 'thinking', values: [false, true] }],
    };
    await show(connectedCatalog([{ ...system, providers: [{ ...provider, models: [opus] }] }]));
    const dialog = await openSettings();
    const thinking = within(dialog).getByRole('checkbox', { name: 'Thinking' });
    expect(thinking).toBeChecked();
    await userEvent.click(thinking);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Launch' }));
    await waitFor(() => {
      expect(launchT3).toHaveBeenCalledOnce();
    });
    expect(launchCalls()[0]?.model.options).toEqual([{ id: 'thinking', value: false }]);
  });

  it('sends a branch only for a worktree', async () => {
    await show(connectedCatalog([reachableSystem()]));
    const dialog = await openSettings();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Advanced' }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: /^Branch/ }), ' feat/launch ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Launch' }));
    await waitFor(() => {
      expect(launchT3).toHaveBeenCalledOnce();
    });
    expect(launchCalls()[0]?.workspace).toEqual({ branch: 'feat/launch', type: 'worktree' });
  });

  it('limits the runtime modes to the provider’s and groups models by provider', async () => {
    await show(connectedCatalog([reachableSystem()]));
    const dialog = await openSettings();
    const modes = within(await optionsOf(dialog, 'Runtime'))
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(modes).toEqual(['Approval required', 'Auto-accept edits', 'Full access']);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).toBeNull();
    });
    const models = await optionsOf(dialog, 'Model');
    expect(within(models).getByRole('group', { name: 'Claude' })).toBeInTheDocument();
  });

  it('asks for the project when several match, and launches once one is picked', async () => {
    const system = reachableSystem({
      projects: [
        { defaultModelSelection: null, id: 'p1', title: 'one' },
        { defaultModelSelection: null, id: 'p2', title: 'two' },
      ],
    });
    await show(connectedCatalog([system]));
    const dialog = await openSettings();
    expect(within(dialog).getByRole('button', { name: 'Launch' })).toBeDisabled();
    await choose(dialog, 'Project', 'two');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Launch' }));
    await waitFor(() => {
      expect(launchT3).toHaveBeenCalledOnce();
    });
    expect(launchCalls()[0]?.projectId).toBe('p2');
  });

  // MMR-742's finding: the old dialog dropped focus to <body> on close on a desktop.
  it('returns focus to More when the settings close, its row being gone', async () => {
    await show(connectedCatalog([reachableSystem()]));
    const dialog = await openSettings();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(dialog).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'More' })).toHaveFocus();
  });

  it('closes on Cancel without launching', async () => {
    await show(connectedCatalog([reachableSystem()]));
    const dialog = await openSettings();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(launchT3).not.toHaveBeenCalled();
  });
});

/** Launch from the settings form, at its defaults. */
async function launchFromSettings() {
  const dialog = await openSettings();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Launch' }));
}

async function launchNow(answer: T3LaunchResult) {
  await show(connectedCatalog([reachableSystem()]), answer);
  await launchFromSettings();
  await waitFor(() => {
    expect(launchT3).toHaveBeenCalled();
  });
}

describe('the answers', () => {
  const link = 't3code://threads/env-1/thread-1';

  it('launched: says so, offers Open in T3, and remembers the choice', async () => {
    const open = vi.spyOn(globalThis, 'open').mockReturnValue(null);
    await launchNow(LAUNCHED);
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        'Launched on Valhalla. MMR-9 is queued.',
        expect.anything(),
      );
    });
    toastAction(toast.success, 'Open in T3')?.onClick();
    expect(open).toHaveBeenCalledWith(link, '_self');
    expect(JSON.parse(localStorage.getItem('mimir:t3-launch:MMR') ?? 'null')).toMatchObject({
      instanceId: 'claude',
      model: 'opus',
      runtimeMode: 'full-access',
    });
    open.mockRestore();
  });

  it('not_queued: errors with the message, Open in T3, and a Retry on the same attempt', async () => {
    await launchNow({ ...LAUNCHED, message: 'no longer ready', state: 'not_queued' });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('no longer ready'),
        expect.anything(),
      );
    });
    expect(toastAction(toast.error, 'Open in T3')).toBeDefined();
    toastAction(toast.error, 'Retry')?.onClick();
    await waitFor(() => {
      expect(launchT3).toHaveBeenCalledTimes(2);
    });
    const [first, second] = launchCalls();
    expect(second).toEqual(first);
  });

  it('unreachable: errors with a Retry on the same attempt, and a new launch gets a new one', async () => {
    await launchNow({ state: 'unreachable' });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    expect(toastAction(toast.error, 'Open in T3')).toBeUndefined();
    toastAction(toast.error, 'Retry')?.onClick();
    await waitFor(() => {
      expect(launchT3).toHaveBeenCalledTimes(2);
    });
    await launchFromSettings();
    await waitFor(() => {
      expect(launchT3).toHaveBeenCalledTimes(3);
    });
    const [first, retry, fresh] = launchCalls();
    expect(retry?.attempt).toBe(first?.attempt);
    expect(fresh?.attempt).not.toBe(first?.attempt);
  });

  it('a launch that did not queue leaves the stored choice as it was', async () => {
    const stored = JSON.stringify({
      instanceId: 'claude',
      model: 'sonnet',
      runtimeMode: 'approval-required',
    });
    localStorage.setItem('mimir:t3-launch:MMR', stored);
    await launchNow({ ...LAUNCHED, message: 'no longer ready', state: 'not_queued' });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    expect(localStorage.getItem('mimir:t3-launch:MMR')).toBe(stored);
  });

  it('an invalid answer rereads the catalog', async () => {
    await show(connectedCatalog([reachableSystem()]), { field: 'model', state: 'invalid' });
    await launchFromSettings();
    await waitFor(() => {
      expect(t3Catalog).toHaveBeenCalledTimes(2);
    });
  });
});
