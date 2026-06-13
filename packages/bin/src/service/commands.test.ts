import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fakeIo } from "../cli/testing";
import { readServeConfig } from "./config";
import { recentEvents } from "./events";
import type { ServiceDeps } from "./commands";
import { cmdSelfUpdate, cmdService } from "./commands";
import type { ServiceInfo, Supervisor } from "./launchd";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mimir-svc-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

class FakeSupervisor implements Supervisor {
  calls: string[] = [];
  state: ServiceInfo = { loaded: false, running: false };
  install(): Promise<void> {
    this.calls.push("install");
    return Promise.resolve();
  }
  uninstall(): Promise<void> {
    this.calls.push("uninstall");
    return Promise.resolve();
  }
  start(): Promise<void> {
    this.calls.push("start");
    return Promise.resolve();
  }
  stop(): Promise<void> {
    this.calls.push("stop");
    return Promise.resolve();
  }
  restart(): Promise<void> {
    this.calls.push("restart");
    return Promise.resolve();
  }
  info(): Promise<ServiceInfo> {
    return Promise.resolve(this.state);
  }
}

function deps(sup: FakeSupervisor, extra: Partial<ServiceDeps> = {}): ServiceDeps {
  return {
    supervisor: sup,
    platform: "darwin",
    binPath: join(dir, "mimir"),
    version: "0.5.0",
    configFile: join(dir, "config.toml"),
    plistFile: join(dir, "com.dbtlr.mimir.serve.plist"),
    eventsFile: join(dir, "service-events.jsonl"),
    health: () => Promise.resolve(undefined),
    fetcher: () => Promise.reject(new Error("no network in tests")),
    dbPath: undefined,
    ...extra,
  };
}

// 1. install writes the plist, delegates, logs, and --port writes config
test("install writes the plist, delegates, logs, and --port writes config", async () => {
  const sup = new FakeSupervisor();
  const io = fakeIo();
  const d = deps(sup);

  const code = await cmdService(["service", "install"], { port: "55440" }, io, d);

  expect(code).toBe(0);
  expect(existsSync(d.plistFile)).toBe(true);
  const plistContent = readFileSync(d.plistFile, "utf8");
  expect(plistContent).toContain("--no-hunt");
  const config = readServeConfig(d.configFile);
  expect(config).toEqual({ port: 55440 });
  expect(sup.calls).toEqual(["install"]);
  const events = recentEvents(d.eventsFile, 10);
  expect(events.map((e) => e.event)).toEqual(["install"]);
  expect(io.out.join("\n")).toContain("55440");
});

// 2. install without --port leaves config untouched
test("install without --port leaves config untouched", async () => {
  const sup = new FakeSupervisor();
  const io = fakeIo();
  const d = deps(sup);

  const code = await cmdService(["service", "install"], {}, io, d);

  expect(code).toBe(0);
  expect(existsSync(d.configFile)).toBe(false);
});

// 3. a bad --port is a usage error and touches nothing
test("a bad --port is a usage error and touches nothing", async () => {
  const sup = new FakeSupervisor();
  const io = fakeIo();
  const d = deps(sup);

  let thrown: unknown;
  try {
    await cmdService(["service", "install"], { port: "no" }, io, d);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeDefined();
  expect(thrown instanceof Error && thrown.message).toMatch(/--port/);
  expect(sup.calls).toEqual([]);
  expect(existsSync(d.plistFile)).toBe(false);
});

// 4. start/stop/restart delegate and log
test("start/stop/restart delegate and log", async () => {
  for (const verb of ["start", "stop", "restart"] as const) {
    const localSup = new FakeSupervisor();
    // Use a fresh sub-directory per verb so events files don't accumulate
    const verbDir = mkdtempSync(join(tmpdir(), `mimir-svc-${verb}-`));
    try {
      const localD: ServiceDeps = {
        supervisor: localSup,
        platform: "darwin",
        binPath: join(verbDir, "mimir"),
        version: "0.5.0",
        configFile: join(verbDir, "config.toml"),
        plistFile: join(verbDir, "com.dbtlr.mimir.serve.plist"),
        eventsFile: join(verbDir, "service-events.jsonl"),
        health: () => Promise.resolve(undefined),
        fetcher: () => Promise.reject(new Error("no network in tests")),
        dbPath: undefined,
      };
      const localIo = fakeIo();
      const code = await cmdService(["service", verb], {}, localIo, localD);
      expect(code).toBe(0);
      expect(localSup.calls).toEqual([verb]);
      const events = recentEvents(localD.eventsFile, 10);
      expect(events.map((e) => e.event)).toEqual([verb]);
    } finally {
      rmSync(verbDir, { recursive: true, force: true });
    }
  }
});

// 5. unknown subcommand is usage; non-darwin is a loud operational error
test("unknown subcommand is usage; non-darwin is a loud operational error", async () => {
  const io = fakeIo();

  // unknown subcommand
  {
    const sup = new FakeSupervisor();
    const d = deps(sup);
    let thrown: unknown;
    try {
      await cmdService(["service", "badverb"], {}, io, d);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(thrown instanceof Error && thrown.message).toMatch(/service:/);
  }

  // non-darwin
  {
    const sup = new FakeSupervisor();
    const d = deps(sup, { platform: "linux" });
    let thrown: unknown;
    try {
      await cmdService(["service", "start"], {}, io, d);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(thrown instanceof Error && thrown.message).toMatch(/macOS/);
  }
});

// 6. status reports running vs on-disk version and restart pending
test("status reports running vs on-disk version and restart pending", async () => {
  const sup = new FakeSupervisor();
  sup.state = { loaded: true, running: true, pid: 4242 };
  const io = fakeIo();
  const d = deps(sup, {
    version: "0.6.0",
    health: () => Promise.resolve({ status: "ok", version: "0.5.0" }),
  });

  const code = await cmdService(["service", "status"], {}, io, d);

  expect(code).toBe(0);
  const out = io.out.join("\n");
  expect(out).toContain("4242");
  expect(out).toContain("running 0.5.0");
  expect(out).toContain("on-disk 0.6.0");
  expect(out).toContain("restart pending");
});

// 7. status when not loaded says so and still shows paths
test("status when not loaded says so and still shows paths", async () => {
  const sup = new FakeSupervisor();
  // state default: loaded: false, running: false
  const io = fakeIo();
  const d = deps(sup);

  const code = await cmdService(["service", "status"], {}, io, d);

  expect(code).toBe(0);
  const out = io.out.join("\n");
  expect(out).toContain("not loaded");
  expect(out).toContain("paths:");
});

// 8. status surfaces an ignored config
test("status surfaces an ignored config", async () => {
  const sup = new FakeSupervisor();
  const io = fakeIo();
  const d = deps(sup);
  // Write a bad config file
  writeFileSync(d.configFile, '[serve]\nport = "x"\n');

  const code = await cmdService(["service", "status"], {}, io, d);

  expect(code).toBe(0);
  const out = io.out.join("\n");
  expect(out).toContain("config ignored (invalid-port)");
});

// 9. self-update: already up to date is a clean no-op
test("self-update: already up to date is a clean no-op", async () => {
  const sup = new FakeSupervisor();
  const io = fakeIo();
  const d = deps(sup, {
    fetcher: (url: string) => {
      // resolveLatestTag fetches /releases/latest and expects a 302 with Location header
      if (url.includes("/releases/latest")) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "https://github.com/dbtlr/mimir/releases/tag/v0.5.0" },
          }),
        );
      }
      return Promise.reject(new Error("unexpected fetch in test"));
    },
  });

  const code = await cmdSelfUpdate(io, d);

  expect(code).toBe(0);
  expect(io.out.join("\n")).toContain("up to date");
  expect(existsSync(d.eventsFile)).toBe(false);
});

// 10. self-update refuses when not a compiled binary
test("self-update refuses when not a compiled binary", async () => {
  const sup = new FakeSupervisor();
  const io = fakeIo();
  const d = deps(sup, { binPath: "/opt/homebrew/bin/bun" });

  let thrown: unknown;
  try {
    await cmdSelfUpdate(io, d);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeDefined();
  expect(thrown instanceof Error && thrown.message).toMatch(/installed binary/);
});
