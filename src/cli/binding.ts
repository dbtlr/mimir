/**
 * Project Binding (ADR 0011) — the checked-in `.mimir.toml` declaring which
 * project a working copy belongs to (`project = "KEY"`). Owned by the binary:
 * `bind` writes it, and every command resolves it walking up from cwd
 * (nearest file wins) as the default `-s` scope. The store knows no
 * filesystem paths — binding direction is repo → project, never the reverse.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const BINDING_FILE = ".mimir.toml";

/** Extract the bound project key from binding-file text, if present. */
export function parseBinding(text: string): string | undefined {
  for (const line of text.split("\n")) {
    const m = /^\s*project\s*=\s*"([A-Z]{2,4})"\s*(?:#.*)?$/.exec(line);
    if (m !== null) return m[1];
  }
  return undefined;
}

/**
 * Walk up from `startDir`; the nearest binding file wins. A malformed nearest
 * file resolves to no binding rather than falling through to an outer one —
 * silently scoping to a *different* project's board would be worse than no
 * default at all.
 */
export function findBinding(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    const file = join(dir, BINDING_FILE);
    if (existsSync(file)) {
      return parseBinding(readFileSync(file, "utf8"));
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Write the binding into `dir`, returning the file path written. */
export function writeBinding(dir: string, key: string): string {
  const file = join(dir, BINDING_FILE);
  writeFileSync(file, `project = "${key}"\n`);
  return file;
}
