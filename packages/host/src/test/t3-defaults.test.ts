import { beforeEach, describe, expect, it } from 'vitest';

import {
  defaultsForSystem,
  launchDefaults,
  recallChoice,
  rememberChoice,
  startingChoice,
} from '../lib/t3-defaults';
import type { LaunchChoice, RememberedChoice } from '../lib/t3-defaults';
import { reachableSystem, unreachableSystem } from './t3-fixtures';

const REMEMBERED: RememberedChoice = {
  instanceId: 'claude',
  model: 'sonnet',
  runtimeMode: 'auto-accept-edits',
};

describe('launchDefaults (ADR 0040, Defaults)', () => {
  it('builds a complete choice from the configured system', () => {
    expect(launchDefaults([reachableSystem()], null)).toEqual({
      environmentId: 'env-1',
      interactionMode: 'default',
      model: { instanceId: 'claude', model: 'opus', options: [{ id: 'effort', value: 'high' }] },
      projectId: 'proj-1',
      runtimeMode: 'full-access',
      workspace: { type: 'worktree' },
    });
  });

  it('prefers the configured server (listed first) when it is reachable with a project', () => {
    const peer = reachableSystem({ configured: false, environmentId: 'peer', label: 'asgard' });
    expect(launchDefaults([reachableSystem(), peer], null)?.environmentId).toBe('env-1');
  });

  it('prefers a configured entry with a match even when it is listed after a peer', () => {
    const peer = reachableSystem({ configured: false, environmentId: 'peer', label: 'asgard' });
    expect(launchDefaults([peer, reachableSystem()], null)?.environmentId).toBe('env-1');
  });

  it('picks no system when two reachable peers match and the configured server has no entry', () => {
    const peers = [
      reachableSystem({ configured: false, environmentId: 'a', label: 'a' }),
      reachableSystem({ configured: false, environmentId: 'b', label: 'b' }),
    ];
    expect(launchDefaults(peers, null)).toBeNull();
  });

  it('takes the only reachable system when the configured server is unreachable', () => {
    const peer = reachableSystem({ configured: false, environmentId: 'peer', label: 'asgard' });
    expect(
      launchDefaults([unreachableSystem('env-1', 'Valhalla', true), peer], null)?.environmentId,
    ).toBe('peer');
  });

  it('picks no system when several peers are reachable and the configured one is not', () => {
    const peers = [
      reachableSystem({ configured: false, environmentId: 'a', label: 'a' }),
      reachableSystem({ configured: false, environmentId: 'b', label: 'b' }),
    ];
    expect(
      launchDefaults([unreachableSystem('env-1', 'Valhalla', true), ...peers], null),
    ).toBeNull();
  });

  it('picks nothing when no system is reachable', () => {
    expect(launchDefaults([unreachableSystem()], null)).toBeNull();
    expect(launchDefaults([], null)).toBeNull();
  });

  it('has no default project when several match', () => {
    const system = reachableSystem({
      projects: [
        { defaultModelSelection: null, id: 'p1', title: 'one' },
        { defaultModelSelection: null, id: 'p2', title: 'two' },
      ],
    });
    expect(defaultsForSystem(system, null)).toBeNull();
  });

  it('falls back to the remembered model when the provider default is not offered', () => {
    const system = reachableSystem({
      projects: [
        { defaultModelSelection: { instanceId: 'claude', model: 'gone' }, id: 'p', title: 't' },
      ],
    });
    const choice = defaultsForSystem(system, REMEMBERED);
    expect(choice?.model).toEqual({ instanceId: 'claude', model: 'sonnet', options: [] });
    expect(choice?.runtimeMode).toBe('auto-accept-edits');
  });

  it('has no default model when neither the default nor the remembered one is offered', () => {
    const system = reachableSystem({
      projects: [{ defaultModelSelection: null, id: 'p', title: 't' }],
    });
    expect(defaultsForSystem(system, null)).toBeNull();
    expect(defaultsForSystem(system, { ...REMEMBERED, model: 'gone' })).toBeNull();
  });

  it('omits an option whose default is not one of its values', () => {
    const base = reachableSystem();
    const system = reachableSystem({
      providers: [
        {
          ...base.providers[0]!,
          models: [
            {
              id: 'opus',
              label: null,
              options: [
                { default: 'ultra', id: 'effort', values: ['low', 'high'] },
                { default: 'high', id: 'keep', values: ['low', 'high'] },
              ],
            },
          ],
        },
      ],
    });
    expect(defaultsForSystem(system, null)?.model.options).toEqual([{ id: 'keep', value: 'high' }]);
  });

  it('uses the remembered runtime mode when the provider still allows it, else the broadest', () => {
    const system = reachableSystem();
    expect(
      defaultsForSystem(system, { ...REMEMBERED, runtimeMode: 'approval-required' })?.runtimeMode,
    ).toBe('approval-required');
    expect(defaultsForSystem(system, { ...REMEMBERED, runtimeMode: 'auto' })?.runtimeMode).toBe(
      'full-access',
    );
  });

  it('follows the system for the workspace: worktree, else the project checkout', () => {
    expect(
      defaultsForSystem(reachableSystem({ defaultThreadEnvMode: 'local' }), null)?.workspace,
    ).toEqual({
      type: 'root',
    });
    expect(
      defaultsForSystem(reachableSystem({ defaultThreadEnvMode: null }), null)?.workspace,
    ).toEqual({
      type: 'root',
    });
  });

  it('is null when the provider allows no runtime mode', () => {
    const base = reachableSystem();
    const system = reachableSystem({ providers: [{ ...base.providers[0]!, runtimeModes: [] }] });
    expect(defaultsForSystem(system, null)).toBeNull();
  });
});

describe('startingChoice', () => {
  it('fills what defaults cannot: no project when several, the first model otherwise', () => {
    const system = reachableSystem({
      projects: [
        { defaultModelSelection: null, id: 'p1', title: 'one' },
        { defaultModelSelection: null, id: 'p2', title: 'two' },
      ],
    });
    const choice = startingChoice(system, null);
    expect(choice?.projectId).toBe('');
    expect(choice?.model.model).toBe('opus');
  });

  it('is null for a system with no model to start from', () => {
    expect(startingChoice(reachableSystem({ providers: [] }), null)).toBeNull();
  });
});

describe('the remembered choice', () => {
  const choice: LaunchChoice = {
    environmentId: 'env-1',
    interactionMode: 'plan',
    model: { instanceId: 'claude', model: 'opus', options: [{ id: 'effort', value: 'low' }] },
    projectId: 'proj-1',
    runtimeMode: 'auto',
    workspace: { type: 'root' },
  };

  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips the model and runtime mode per Mimir project, without options', () => {
    rememberChoice('MMR', choice);
    expect(recallChoice('MMR')).toEqual({
      instanceId: 'claude',
      model: 'opus',
      runtimeMode: 'auto',
    });
    expect(JSON.parse(localStorage.getItem('mimir:t3-launch:MMR') ?? 'null')).not.toHaveProperty(
      'options',
    );
    expect(recallChoice('OTH')).toBeNull();
  });

  it('ignores the options an older stored value still carries', () => {
    localStorage.setItem(
      'mimir:t3-launch:MMR',
      JSON.stringify({
        instanceId: 'a',
        model: 'b',
        options: [{ id: 'effort', value: 'low' }],
        runtimeMode: 'auto',
      }),
    );
    expect(recallChoice('MMR')).toEqual({ instanceId: 'a', model: 'b', runtimeMode: 'auto' });
    localStorage.setItem(
      'mimir:t3-launch:MMR',
      JSON.stringify({ instanceId: 'a', model: 'b', options: 3, runtimeMode: 'auto' }),
    );
    expect(recallChoice('MMR')?.model).toBe('b');
  });

  it.each([
    ['not JSON', '{nope'],
    ['not an object', '"x"'],
    ['a bad runtime mode', JSON.stringify({ instanceId: 'a', model: 'b', runtimeMode: 'x' })],
  ])('reads %s as nothing remembered', (_name, raw) => {
    localStorage.setItem('mimir:t3-launch:MMR', raw);
    expect(recallChoice('MMR')).toBeNull();
  });

  it('tolerates storage that throws', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('denied');
      },
    });
    try {
      expect(recallChoice('MMR')).toBeNull();
      expect(() => {
        rememberChoice('MMR', choice);
      }).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, 'localStorage', original!);
    }
  });
});
