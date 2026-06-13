import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  // serve.log must appear exactly twice: once for StandardOutPath and once for StandardErrorPath
  expect(xml.split("serve.log").length - 1).toBe(2);
  expect(xml).not.toContain("MIMIR_DB");
  // ProgramArguments array must appear in order with exact whitespace
  expect(xml).toContain(
    [
      "  <array>",
      "    <string>/Users/op/.local/bin/mimir</string>",
      "    <string>serve</string>",
      "    <string>--no-hunt</string>",
      "  </array>",
    ].join("\n"),
  );
});

test("MIMIR_DB present at install time is baked into the environment", () => {
  const xml = plistFor("/usr/local/bin/mimir", { dbPath: "/data/mimir.db" });
  expect(xml).toContain("<key>MIMIR_DB</key>");
  expect(xml).toContain("<string>/data/mimir.db</string>");
});

test("plistPath lands in the user's LaunchAgents", () => {
  expect(plistPath()).toMatch(/Library\/LaunchAgents\/com\.dbtlr\.mimir\.serve\.plist$/);
});

// XML-escape tests — launchctl rejects malformed plists loudly but the error
// message never points at the offending character, making this class of bug
// very hard to diagnose after the fact.
test("special XML characters in binPath and dbPath are escaped", () => {
  const xml = plistFor("/Users/op/Drew & Co/bin/mimir", {
    dbPath: "/data/a<b/m.db",
  });
  expect(xml).toContain("Drew &amp; Co");
  expect(xml).toContain("a&lt;b");
  // must not contain the raw characters inside element content
  expect(xml).not.toContain("Drew & Co");
  expect(xml).not.toContain("a<b");
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mimir-plist-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// plutil is macOS-only — the escaping is asserted on the string above for
// every platform; this adds real plist validation where the tool exists (dev
// + the macOS release runner), and is skipped on Linux CI.
test.skipIf(process.platform !== "darwin")("escaped plist passes plutil -lint", () => {
  const xml = plistFor("/Users/op/Drew & Co/bin/mimir", {
    dbPath: "/data/a<b/m.db",
  });
  const file = join(dir, "test.plist");
  writeFileSync(file, xml, "utf8");
  const result = Bun.spawnSync(["plutil", "-lint", file]);
  expect(result.exitCode).toBe(0);
});
