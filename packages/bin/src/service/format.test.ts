import { describe, expect, test } from 'bun:test';

import { formatSelfUpdateJson, formatServiceActionJson, formatServiceStatusJson } from './format';
import type { SelfUpdateResult, ServiceActionResult, ServiceStatus } from './format';

const runningStatus = (over: Partial<ServiceStatus> = {}): ServiceStatus => ({
  configProblem: null,
  health: { onDiskVersion: '0.6.0', restartPending: true, runningVersion: '0.5.0' },
  loaded: true,
  paths: { config: '/p/config', log: '/p/log', plist: '/p/plist' },
  pid: 4242,
  port: 64647,
  recentEvents: [
    {
      at: '2026-06-14T00:00:00.000Z',
      event: 'install',
      source: 'cli',
      version: '0.6.0',
      ok: true,
      detail: 'port 64647',
    },
  ],
  running: true,
  ...over,
});

describe('formatServiceStatusJson', () => {
  test('running status maps to the snake_case envelope', () => {
    const parsed = JSON.parse(formatServiceStatusJson(runningStatus(), true));
    expect(parsed).toEqual({
      config_problem: null,
      health: { on_disk_version: '0.6.0', restart_pending: true, running_version: '0.5.0' },
      loaded: true,
      paths: { config: '/p/config', log: '/p/log', plist: '/p/plist' },
      pid: 4242,
      port: 64647,
      recent_events: [
        {
          at: '2026-06-14T00:00:00.000Z',
          event: 'install',
          source: 'cli',
          version: '0.6.0',
          ok: true,
          detail: 'port 64647',
        },
      ],
      running: true,
    });
  });

  test('not loaded → pid null, health null, config_problem carried', () => {
    const parsed = JSON.parse(
      formatServiceStatusJson(
        runningStatus({
          configProblem: 'invalid-port',
          health: null,
          loaded: false,
          pid: null,
          recentEvents: [],
          running: false,
        }),
        true,
      ),
    );
    expect(parsed.pid).toBeNull();
    expect(parsed.health).toBeNull();
    expect(parsed.config_problem).toBe('invalid-port');
    expect(parsed.recent_events).toEqual([]);
  });

  test('jsonl variant is single-line', () => {
    const line = formatServiceStatusJson(runningStatus(), false);
    expect(line).not.toContain('\n');
    expect(JSON.parse(line).loaded).toBe(true);
  });
});

describe('formatServiceActionJson', () => {
  test('install carries port and paths', () => {
    const r: ServiceActionResult = {
      action: 'install',
      ok: true,
      paths: { config: '/p/config', log: '/p/log', plist: '/p/plist' },
      port: 55440,
    };
    expect(JSON.parse(formatServiceActionJson(r, true))).toEqual({
      action: 'install',
      ok: true,
      paths: { config: '/p/config', log: '/p/log', plist: '/p/plist' },
      port: 55440,
    });
  });

  test('lighter verbs are just action + ok', () => {
    const r: ServiceActionResult = { action: 'start', ok: true };
    expect(JSON.parse(formatServiceActionJson(r, true))).toEqual({ action: 'start', ok: true });
  });
});

describe('formatSelfUpdateJson', () => {
  test('an applied update', () => {
    const r: SelfUpdateResult = {
      asset: 'mimir-darwin-arm64',
      from: '0.6.0',
      restartFailed: false,
      restarted: true,
      to: '0.7.0',
      updated: true,
    };
    expect(JSON.parse(formatSelfUpdateJson(r, true))).toEqual({
      asset: 'mimir-darwin-arm64',
      from: '0.6.0',
      restart_failed: false,
      restarted: true,
      to: '0.7.0',
      updated: true,
    });
  });

  test('already current → updated false, to equals from', () => {
    const r: SelfUpdateResult = {
      asset: 'mimir-darwin-arm64',
      from: '0.6.0',
      restartFailed: false,
      restarted: false,
      to: '0.6.0',
      updated: false,
    };
    const parsed = JSON.parse(formatSelfUpdateJson(r, true));
    expect(parsed.updated).toBe(false);
    expect(parsed.to).toBe(parsed.from);
  });
});
