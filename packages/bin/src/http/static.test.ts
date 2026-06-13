import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import type { Db } from "../core";
import { createTestDb } from "../db/testing";
import { createServer } from "./server";
import type { UiAssetMap } from "./static";

/**
 * The embedded console over the real server: exact assets with their
 * content-type and cache posture, the SPA fallback for client routes,
 * /api/* untouched, and the no-UI 404. Fixture files stand in for the
 * embedded dist (same mechanism: paths `Bun.file` can open).
 */

let db: Db;
let server: Server<undefined> | undefined;
let dir: string;

beforeEach(async () => {
  db = await createTestDb();
  dir = mkdtempSync(join(tmpdir(), "mimir-ui-assets-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Mimir</title>");
  writeFileSync(join(dir, "app-abc123.js"), "console.log('mimir')");
});

afterEach(async () => {
  await server?.stop(true);
  server = undefined;
  await db.destroy();
  rmSync(dir, { recursive: true, force: true });
});

function fixtureAssets(): UiAssetMap {
  return {
    "/index.html": {
      file: join(dir, "index.html"),
      type: "text/html; charset=utf-8",
      immutable: false,
    },
    "/assets/app-abc123.js": {
      file: join(dir, "app-abc123.js"),
      type: "text/javascript; charset=utf-8",
      immutable: true,
    },
  };
}

function start(assets: UiAssetMap): string {
  server = createServer(db, { port: 0, version: "0.0.0-test", assets });
  return `http://127.0.0.1:${String(server.port)}`;
}

test("serves an exact asset with content-type and immutable caching", async () => {
  const base = start(fixtureAssets());
  const res = await fetch(`${base}/assets/app-abc123.js`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(await res.text()).toBe("console.log('mimir')");
});

test("serves index.html at / without immutable caching", async () => {
  const base = start(fixtureAssets());
  const res = await fetch(`${base}/`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(res.headers.get("cache-control")).toBe("no-cache");
  expect(await res.text()).toContain("<title>Mimir</title>");
});

test("any non-/api miss falls back to index.html — the SPA owns its routes", async () => {
  const base = start(fixtureAssets());
  for (const path of ["/p/MMR", "/p/MMR?view=tree&node=MMR-16", "/nope"]) {
    const res = await fetch(`${base}${path}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain("<title>Mimir</title>");
  }
});

test("/api/* stays the resource envelope — routes answer, misses stay JSON 404s", async () => {
  const base = start(fixtureAssets());
  const api = await fetch(`${base}/api/projects`);
  expect(api.status).toBe(200);
  expect(api.headers.get("content-type")).toContain("application/json");
  expect(((await api.json()) as { items: unknown[] }).items).toEqual([]);

  const miss = await fetch(`${base}/api/nope`);
  expect(miss.status).toBe(404);
  const body = (await miss.json()) as { error: { code: string } };
  expect(body.error.code).toBe("not_found");
});

test("an empty manifest serves no UI — non-/api paths are JSON 404s", async () => {
  const base = start({});
  for (const path of ["/", "/p/MMR"]) {
    const res = await fetch(`${base}${path}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  }
});

test("non-GET outside /api never hits the asset map", async () => {
  const base = start(fixtureAssets());
  const res = await fetch(`${base}/`, { method: "POST" });
  expect(res.status).toBe(404);
});
