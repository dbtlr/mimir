import { expect, test } from "bun:test";
import { LABEL, plistFor, plistPath } from "./plist";

test("plist runs serve --no-hunt with no port and supervises it", () => {
  const xml = plistFor("/Users/op/.local/bin/mimir", {});
  expect(xml).toContain(`<string>${LABEL}</string>`);
  expect(xml).toContain("<string>/Users/op/.local/bin/mimir</string>");
  expect(xml).toContain("<string>serve</string>");
  expect(xml).toContain("<string>--no-hunt</string>");
  expect(xml).not.toContain("--port"); // the port lives in config, never the plist
  expect(xml).toContain("<key>KeepAlive</key>");
  expect(xml).toContain("<key>RunAtLoad</key>");
  expect(xml).toContain("serve.log");
  expect(xml).not.toContain("MIMIR_DB");
});

test("MIMIR_DB present at install time is baked into the environment", () => {
  const xml = plistFor("/usr/local/bin/mimir", { dbPath: "/data/mimir.db" });
  expect(xml).toContain("<key>MIMIR_DB</key>");
  expect(xml).toContain("<string>/data/mimir.db</string>");
});

test("plistPath lands in the user's LaunchAgents", () => {
  expect(plistPath()).toMatch(/Library\/LaunchAgents\/com\.dbtlr\.mimir\.serve\.plist$/);
});
