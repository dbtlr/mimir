import { expect, test } from "bun:test";
import pkg from "../package.json";
import { VERSION } from "./version";

test("VERSION falls back to package.json when no build version is injected", () => {
  // Unit/dev runs are not compiled with --define, so VERSION === pkg.version.
  expect(VERSION).toBe(pkg.version);
  expect(typeof VERSION).toBe("string");
  expect(VERSION.length).toBeGreaterThan(0);
});
