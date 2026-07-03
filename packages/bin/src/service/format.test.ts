import { describe, expect, test } from 'bun:test';

import { formatSelfUpdateJson, formatServiceActionsJson, formatServiceStatusJson } from './format';
import type {
  SelfUpdateResult,
  ServiceActionResult,
  ServiceStatusReport,
  UnitStatus,
} from './format';

const serveUnit = (over: Partial<UnitStatus> = {}): UnitStatus => ({
  configProblem: null,
  health: { onDiskVersion: '0.6.0', restartPending: true, runningVersion: '0.5.0' },
  loaded: true,
  log: '/p/serve.log',
  pid: 4242,
  plist: '/p/serve.plist',
  port: 64647,
  running: true,
  unit: 'serve',
  ...over,
});

const snapshotUnit = (over: Partial<UnitStatus> = {}): UnitStatus => ({
  intervalSeconds: 900,
  loaded: false,
  log: '/p/snapshot.log',
  pid: null,
  plist: '/p/snapshot.plist',
  running: false,
  unit: 'snapshot',
  ...over,
});

const report = (over: Partial<ServiceStatusReport> = {}): ServiceStatusReport => ({
  config: '/p/config',
  recentEvents: [
    {
      at: '2026-06-14T00:00:00.000Z',
      detail: 'serve · port 64647',
      event: 'install',
      ok: true,
      source: 'cli',
      version: '0.6.0',
    },
  ],
  units: [serveUnit(), snapshotUnit()],
  ...over,
});

describe('formatServiceStatusJson', () => {
  test('a two-unit report maps to the snake_case envelope', () => {
    const parsed = JSON.parse(formatServiceStatusJson(report(), true));
    expect(parsed.config).toBe('/p/config');
    expect(parsed.recent_events).toHaveLength(1);
    const serve = parsed.units.find((u: { unit: string }) => u.unit === 'serve');
    expect(serve).toEqual({
      config_problem: null,
      health: { on_disk_version: '0.6.0', restart_pending: true, running_version: '0.5.0' },
      loaded: true,
      log: '/p/serve.log',
      pid: 4242,
      plist: '/p/serve.plist',
      port: 64647,
      running: true,
      unit: 'serve',
    });
    const snap = parsed.units.find((u: { unit: string }) => u.unit === 'snapshot');
    expect(snap).toEqual({
      interval_seconds: 900,
      loaded: false,
      log: '/p/snapshot.log',
      pid: null,
      plist: '/p/snapshot.plist',
      running: false,
      unit: 'snapshot',
    });
    // The serve-only and snapshot-only keys never cross over.
    expect(snap.port).toBeUndefined();
    expect(serve.interval_seconds).toBeUndefined();
  });

  test('not loaded → pid null, health null, config_problem carried', () => {
    const parsed = JSON.parse(
      formatServiceStatusJson(
        report({
          units: [
            serveUnit({ configProblem: 'invalid-port', health: null, loaded: false, pid: null }),
          ],
        }),
        true,
      ),
    );
    const serve = parsed.units[0];
    expect(serve.pid).toBeNull();
    expect(serve.health).toBeNull();
    expect(serve.config_problem).toBe('invalid-port');
  });

  test('jsonl variant is single-line', () => {
    const line = formatServiceStatusJson(report(), false);
    expect(line).not.toContain('\n');
    expect(JSON.parse(line).units).toHaveLength(2);
  });
});

describe('formatServiceActionsJson', () => {
  test('json wraps the results in an actions array', () => {
    const r: ServiceActionResult = {
      action: 'install',
      ok: true,
      paths: { config: '/p/config', log: '/p/log', plist: '/p/plist' },
      port: 55440,
      unit: 'serve',
    };
    expect(JSON.parse(formatServiceActionsJson([r], 'json'))).toEqual({
      actions: [
        {
          action: 'install',
          ok: true,
          paths: { config: '/p/config', log: '/p/log', plist: '/p/plist' },
          port: 55440,
          unit: 'serve',
        },
      ],
    });
  });

  test('jsonl emits one object per line, lighter verbs are action + ok + unit', () => {
    const results: ServiceActionResult[] = [
      { action: 'start', ok: true, unit: 'serve' },
      { action: 'start', ok: true, unit: 'snapshot' },
    ];
    const lines = formatServiceActionsJson(results, 'jsonl').split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '')).toEqual({ action: 'start', ok: true, unit: 'serve' });
    expect(JSON.parse(lines[1] ?? '')).toEqual({ action: 'start', ok: true, unit: 'snapshot' });
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
