import { describe, expect, test } from "bun:test";
import {
  type SelfUpdateResult,
  type ServiceActionResult,
  type ServiceStatus,
  formatSelfUpdateJson,
  formatServiceActionJson,
  formatServiceStatusJson,
} from "./format";

const runningStatus = (over: Partial<ServiceStatus> = {}): ServiceStatus => ({
  loaded: true,
  running: true,
  pid: 4242,
  port: 64647,
  configProblem: null,
  health: { runningVersion: "0.5.0", onDiskVersion: "0.6.0", restartPending: true },
  recentEvents: [
    {
      at: "2026-06-14T00:00:00.000Z",
      event: "install",
      source: "cli",
      version: "0.6.0",
      ok: true,
      detail: "port 64647",
    },
  ],
  paths: { plist: "/p/plist", config: "/p/config", log: "/p/log" },
  ...over,
});

describe("formatServiceStatusJson", () => {
  test("running status maps to the snake_case envelope", () => {
    const parsed = JSON.parse(formatServiceStatusJson(runningStatus(), true));
    expect(parsed).toEqual({
      loaded: true,
      running: true,
      pid: 4242,
      port: 64647,
      config_problem: null,
      health: { running_version: "0.5.0", on_disk_version: "0.6.0", restart_pending: true },
      recent_events: [
        {
          at: "2026-06-14T00:00:00.000Z",
          event: "install",
          source: "cli",
          version: "0.6.0",
          ok: true,
          detail: "port 64647",
        },
      ],
      paths: { plist: "/p/plist", config: "/p/config", log: "/p/log" },
    });
  });

  test("not loaded → pid null, health null, config_problem carried", () => {
    const parsed = JSON.parse(
      formatServiceStatusJson(
        runningStatus({
          loaded: false,
          running: false,
          pid: null,
          health: null,
          configProblem: "invalid-port",
          recentEvents: [],
        }),
        true,
      ),
    );
    expect(parsed.pid).toBeNull();
    expect(parsed.health).toBeNull();
    expect(parsed.config_problem).toBe("invalid-port");
    expect(parsed.recent_events).toEqual([]);
  });

  test("jsonl variant is single-line", () => {
    const line = formatServiceStatusJson(runningStatus(), false);
    expect(line).not.toContain("\n");
    expect(JSON.parse(line).loaded).toBe(true);
  });
});

describe("formatServiceActionJson", () => {
  test("install carries port and paths", () => {
    const r: ServiceActionResult = {
      action: "install",
      ok: true,
      port: 55440,
      paths: { plist: "/p/plist", config: "/p/config", log: "/p/log" },
    };
    expect(JSON.parse(formatServiceActionJson(r, true))).toEqual({
      action: "install",
      ok: true,
      port: 55440,
      paths: { plist: "/p/plist", config: "/p/config", log: "/p/log" },
    });
  });

  test("lighter verbs are just action + ok", () => {
    const r: ServiceActionResult = { action: "start", ok: true };
    expect(JSON.parse(formatServiceActionJson(r, true))).toEqual({ action: "start", ok: true });
  });
});

describe("formatSelfUpdateJson", () => {
  test("an applied update", () => {
    const r: SelfUpdateResult = {
      from: "0.6.0",
      to: "0.7.0",
      updated: true,
      restarted: true,
      restartFailed: false,
      asset: "mimir-darwin-arm64",
    };
    expect(JSON.parse(formatSelfUpdateJson(r, true))).toEqual({
      from: "0.6.0",
      to: "0.7.0",
      updated: true,
      restarted: true,
      restart_failed: false,
      asset: "mimir-darwin-arm64",
    });
  });

  test("already current → updated false, to equals from", () => {
    const r: SelfUpdateResult = {
      from: "0.6.0",
      to: "0.6.0",
      updated: false,
      restarted: false,
      restartFailed: false,
      asset: "mimir-darwin-arm64",
    };
    const parsed = JSON.parse(formatSelfUpdateJson(r, true));
    expect(parsed.updated).toBe(false);
    expect(parsed.to).toBe(parsed.from);
  });
});
