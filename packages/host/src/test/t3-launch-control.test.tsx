import { QueryClient } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { connectT3, launchT3, t3Catalog, t3Origin } from '../api/fns/t3';
import type { T3Catalog, T3LaunchResult } from '../api/fns/t3';
import { canLaunchOnT3, T3LaunchControl } from '../components/t3-launch-control';
import { T3_ATTEMPT_PATTERN } from '../server/t3-states';
import { engineTask } from './node-fixtures';
import { renderInRouter } from './router';
import { connectedCatalog, reachableSystem, unreachableSystem } from './t3-fixtures';
import { serveT3Launch } from './t3-fns';

vi.mock('../api/fns/t3');
vi.mock('../lib/leave-for');
vi.mock('sonner', () => ({ Toaster: () => null, toast: { error: vi.fn(), success: vi.fn() } }));

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
});

afterEach(() => {
  vi.clearAllMocks();
});

async function show(catalog: T3Catalog, launch?: T3LaunchResult, offline = false) {
  serveT3Launch(catalog, launch);
  return renderInRouter(
    <T3LaunchControl node={task} offline={offline} />,
    new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
}

const launchCalls = () => vi.mocked(launchT3).mock.calls.map(([options]) => options.data);

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

describe('the launch control (ADR 0040)', () => {
  it('renders nothing and never reads the catalog while T3 is unconfigured', async () => {
    serveT3Launch(connectedCatalog([reachableSystem()]), undefined, null);
    const { container } = await renderInRouter(<T3LaunchControl node={task} offline={false} />);
    await waitFor(() => {
      expect(t3Origin).toHaveBeenCalled();
    });
    expect(container).toBeEmptyDOMElement();
    expect(t3Catalog).not.toHaveBeenCalled();
  });

  it('shows a disabled button while the catalog loads', async () => {
    serveT3Launch(connectedCatalog([]));
    vi.mocked(t3Catalog).mockReturnValue(Promise.withResolvers<T3Catalog>().promise);
    await renderInRouter(<T3LaunchControl node={task} offline={false} />);
    await expect(screen.findByRole('button', { name: 'Launch in T3…' })).resolves.toBeDisabled();
  });

  it('names the setting and links to Devices when misconfigured', async () => {
    await show({ problem: 'not HTTPS', setting: 'MIMIR_URL', state: 'misconfigured' });
    await expect(screen.findByRole('link', { name: 'Devices' })).resolves.toHaveAttribute(
      'href',
      '/devices',
    );
    const button = screen.getByRole('button', { name: /Launch in T3/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', expect.stringContaining('MIMIR_URL'));
  });

  it('offers Reconnect T3 when disconnected, and Reconnect starts Connect', async () => {
    vi.mocked(connectT3).mockResolvedValue({ state: 'unreachable' });
    await show({ reason: 'expired', state: 'disconnected' });
    await userEvent.click(await screen.findByRole('button', { name: 'Reconnect T3' }));
    expect(connectT3).toHaveBeenCalledOnce();
  });

  it('says T3 is unreachable and rereads the catalog on select', async () => {
    await show({ state: 'unreachable' });
    await userEvent.click(await screen.findByRole('button', { name: 'T3 unreachable' }));
    await waitFor(() => {
      expect(t3Catalog).toHaveBeenCalledTimes(2);
    });
  });

  it('reads a failed catalog request as unreachable', async () => {
    serveT3Launch(connectedCatalog([]));
    vi.mocked(t3Catalog).mockRejectedValue(new Error('down'));
    await renderInRouter(
      <T3LaunchControl node={task} offline={false} />,
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    );
    await expect(screen.findByRole('button', { name: 'T3 unreachable' })).resolves.toBeEnabled();
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
    await expect(screen.findByText(reason)).resolves.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Launch in T3…' })).toBeDisabled();
  });

  it('is disabled while offline', async () => {
    await show(connectedCatalog([reachableSystem()]), undefined, true);
    await expect(
      screen.findByRole('button', { name: 'Launch on Valhalla' }),
    ).resolves.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Choose where to launch' })).toBeDisabled();
  });
});

describe('the split button', () => {
  it('launches at once with the defaults and a fresh attempt', async () => {
    await show(connectedCatalog([reachableSystem()]));
    await userEvent.click(await screen.findByRole('button', { name: 'Launch on Valhalla' }));
    await waitFor(() => {
      expect(launchT3).toHaveBeenCalledOnce();
    });
    const [input] = launchCalls();
    expect(input).toEqual({ ...DEFAULT_INPUT, attempt: expect.stringMatching(T3_ATTEMPT_PATTERN) });
  });

  it('lists every system in the caret menu, unreachable ones disabled, then Choose settings…', async () => {
    const peer = reachableSystem({ configured: false, environmentId: 'peer', label: 'asgard' });
    await show(connectedCatalog([reachableSystem(), peer, unreachableSystem()]));
    await userEvent.click(await screen.findByRole('button', { name: 'Choose where to launch' }));
    const items = await screen.findAllByRole('menuitem');
    const names = items.map((item) => item.textContent);
    expect(names).toEqual(
      expect.arrayContaining([
        'Launch on Valhalla',
        'Launch on asgard',
        'Launch on DB MBP',
        'Choose settings…',
      ]),
    );
    expect(items[names.indexOf('Launch on DB MBP')]).toHaveAttribute('aria-disabled', 'true');
    expect(items[names.indexOf('Launch on asgard')]).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('launches a peer with that system’s defaults', async () => {
    const peer = reachableSystem({
      configured: false,
      defaultThreadEnvMode: 'local',
      environmentId: 'peer',
      label: 'asgard',
      projects: [
        {
          defaultModelSelection: { instanceId: 'claude', model: 'sonnet' },
          id: 'peer-proj',
          title: 'mimir',
        },
      ],
      providers: [
        {
          displayName: 'Claude',
          models: [{ id: 'sonnet', label: null, options: [] }],
          providerInstanceId: 'claude',
          runtimeModes: ['approval-required'],
        },
      ],
    });
    await show(connectedCatalog([reachableSystem(), peer]));
    await userEvent.click(await screen.findByRole('button', { name: 'Choose where to launch' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Launch on asgard' }));
    await waitFor(() => {
      expect(launchT3).toHaveBeenCalledOnce();
    });
    expect(launchCalls()[0]).toMatchObject({
      environmentId: 'peer',
      model: { instanceId: 'claude', model: 'sonnet', options: [] },
      projectId: 'peer-proj',
      runtimeMode: 'approval-required',
      workspace: { type: 'root' },
    });
  });

  it('opens the settings, preselected, for a system with no defaults', async () => {
    const peer = reachableSystem({
      configured: false,
      environmentId: 'peer',
      label: 'asgard',
      projects: [
        { defaultModelSelection: null, id: 'p1', title: 'one' },
        { defaultModelSelection: null, id: 'p2', title: 'two' },
      ],
    });
    await show(connectedCatalog([reachableSystem(), peer]));
    await userEvent.click(await screen.findByRole('button', { name: 'Choose where to launch' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Launch on asgard' }));
    const dialog = await screen.findByRole('dialog', { name: 'Launch MMR-9 in T3' });
    expect(within(dialog).getByRole('combobox', { name: 'System' })).toHaveValue('peer');
    expect(launchT3).not.toHaveBeenCalled();
  });
});

async function openSettings() {
  await userEvent.click(await screen.findByRole('button', { name: 'Choose where to launch' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Choose settings…' }));
  return screen.findByRole('dialog', { name: 'Launch MMR-9 in T3' });
}

describe('the settings dialog', () => {
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
    expect(within(dialog).getByRole('combobox', { name: 'System' })).toHaveValue('env-1');
  });

  it('starts from the defaults and launches the chosen input', async () => {
    await show(connectedCatalog([reachableSystem()]));
    const dialog = await openSettings();
    expect(within(dialog).queryByRole('combobox', { name: 'Project' })).toBeNull();
    expect(within(dialog).getByRole('combobox', { name: 'Model' })).toHaveValue(
      JSON.stringify(['claude', 'opus']),
    );
    expect(within(dialog).getByRole('radio', { name: 'high' })).toBeChecked();

    await userEvent.click(within(dialog).getByRole('radio', { name: 'low' }));
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Thinking' }));
    await userEvent.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Runtime mode' }),
      'approval-required',
    );
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

  it('sends a branch only for a worktree', async () => {
    await show(connectedCatalog([reachableSystem()]));
    const dialog = await openSettings();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Advanced' }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Branch' }), ' feat/launch ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Launch' }));
    await waitFor(() => {
      expect(launchT3).toHaveBeenCalledOnce();
    });
    expect(launchCalls()[0]?.workspace).toEqual({ branch: 'feat/launch', type: 'worktree' });
  });

  it('limits the runtime modes to the provider’s and groups models by provider', async () => {
    await show(connectedCatalog([reachableSystem()]));
    const dialog = await openSettings();
    const modes = within(within(dialog).getByRole('combobox', { name: 'Runtime mode' }))
      .getAllByRole('option')
      .map((option) => option.getAttribute('value'));
    expect(modes).toEqual(['approval-required', 'auto-accept-edits', 'full-access']);
    expect(within(dialog).getByRole('group', { name: 'Claude' })).toBeInTheDocument();
  });

  it('asks for the project when several match, and launches once one is picked', async () => {
    const system = reachableSystem({
      projects: [
        { defaultModelSelection: null, id: 'p1', title: 'one' },
        { defaultModelSelection: null, id: 'p2', title: 'two' },
      ],
    });
    await show(connectedCatalog([system]));
    // No defaults, so the main half opens the settings.
    await screen.findByRole('button', { name: 'Choose where to launch' });
    await userEvent.click(screen.getByRole('button', { name: 'Launch in T3…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Launch MMR-9 in T3' });
    expect(within(dialog).getByRole('button', { name: 'Launch' })).toBeDisabled();
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: 'Project' }), 'p2');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Launch' }));
    await waitFor(() => {
      expect(launchT3).toHaveBeenCalledOnce();
    });
    expect(launchCalls()[0]?.projectId).toBe('p2');
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

async function launchNow(answer: T3LaunchResult) {
  await show(connectedCatalog([reachableSystem()]), answer);
  await userEvent.click(await screen.findByRole('button', { name: 'Launch on Valhalla' }));
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
    await userEvent.click(await screen.findByRole('button', { name: 'Launch on Valhalla' }));
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
    await userEvent.click(await screen.findByRole('button', { name: 'Launch on Valhalla' }));
    await waitFor(() => {
      expect(t3Catalog).toHaveBeenCalledTimes(2);
    });
  });
});
