import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendEvent, recentEvents } from "./events";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mimir-events-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("append creates the file and recentEvents returns newest-last", () => {
  const file = join(dir, "logs", "service-events.jsonl");
  appendEvent(file, { event: "install", source: "cli", version: "0.5.0", ok: true });
  appendEvent(file, {
    event: "restart",
    source: "self-update",
    version: "0.6.0",
    ok: true,
    detail: "0.5.0 → 0.6.0",
  });
  const events = recentEvents(file, 5);
  expect(events).toHaveLength(2);
  expect(events[1]?.event).toBe("restart");
  expect(events[1]?.detail).toBe("0.5.0 → 0.6.0");
  expect(typeof events[0]?.at).toBe("string");
});

test("recentEvents caps at n, skips corrupt lines, empty when missing", () => {
  const file = join(dir, "e.jsonl");
  expect(recentEvents(file, 3)).toEqual([]);
  for (let i = 0; i < 5; i++) {
    appendEvent(file, { event: "start", source: "cli", version: "0.5.0", ok: true });
  }
  appendFileSync(file, "not json\n");
  expect(recentEvents(file, 3)).toHaveLength(3);
  expect(recentEvents(file, 10).every((e) => e.event === "start")).toBe(true);
  expect(recentEvents(file, 0)).toEqual([]);
});
