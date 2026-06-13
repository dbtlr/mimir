import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configPath, readServeConfig, writeServePort } from "./config";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mimir-config-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("configPath honors XDG_CONFIG_HOME", () => {
  expect(configPath(dir)).toBe(join(dir, "mimir", "config.toml"));
});

test("missing file reads as empty config", () => {
  expect(readServeConfig(join(dir, "nope", "config.toml"))).toEqual({});
});

test("reads [serve] port", () => {
  const file = join(dir, "config.toml");
  writeFileSync(file, "[serve]\nport = 50123\n");
  expect(readServeConfig(file)).toEqual({ port: 50123 });
});

test("malformed TOML or non-integer port reads as empty (no crash)", () => {
  const file = join(dir, "config.toml");
  writeFileSync(file, "[serve\nport = ???");
  expect(readServeConfig(file)).toEqual({});
  writeFileSync(file, '[serve]\nport = "high"\n');
  expect(readServeConfig(file)).toEqual({});
});

test("writeServePort creates parents and round-trips", () => {
  const file = join(dir, "deep", "mimir", "config.toml");
  writeServePort(file, 50124);
  expect(readFileSync(file, "utf8")).toBe("[serve]\nport = 50124\n");
  expect(readServeConfig(file)).toEqual({ port: 50124 });
});
