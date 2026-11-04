import type { T3Catalog, T3System } from '../api/fns/t3';

/** A reachable T3 system with one matching project and one provider with two models. */
export function reachableSystem(
  overrides: Partial<Extract<T3System, { status: 'reachable' }>> = {},
) {
  return {
    defaultThreadEnvMode: 'worktree',
    environmentId: 'env-1',
    label: 'Valhalla',
    projects: [
      {
        defaultModelSelection: { instanceId: 'claude', model: 'opus' },
        id: 'proj-1',
        title: 'mimir',
      },
    ],
    providers: [
      {
        displayName: 'Claude',
        models: [
          {
            id: 'opus',
            label: 'Claude Opus',
            options: [
              { default: 'high', id: 'effort', values: ['low', 'medium', 'high'] },
              { default: null, id: 'thinking', values: [false, true] },
            ],
          },
          { id: 'sonnet', label: null, options: [] },
        ],
        providerInstanceId: 'claude',
        runtimeModes: ['approval-required', 'auto-accept-edits', 'full-access'],
      },
    ],
    status: 'reachable',
    ...overrides,
  } satisfies T3System;
}

export function unreachableSystem(environmentId = 'env-down', label = 'DB MBP'): T3System {
  return { environmentId, label, status: 'unreachable' };
}

export function connectedCatalog(systems: T3System[], noRemote = false): T3Catalog {
  return { expiresAt: '2030-01-01T00:00:00.000Z', noRemote, state: 'connected', systems };
}
