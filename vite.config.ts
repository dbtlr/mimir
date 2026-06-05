import { defineConfig } from "vite-plus";
import type { OxlintConfig } from "oxlint";

type Override = NonNullable<OxlintConfig["overrides"]>[number];

/**
 * Layer-boundary enforcement.
 *
 * `contract` is the dependency-free *type leaf* — pure DTO/enum types that
 * `db`, `core`, and the transports all import, and that the UI extracts as a
 * shared package (ADR 0010). So `contract` imports nothing; everyone may import
 * `contract`. The real flow is `contract ← db ← core ← transports`:
 *   - `db` may import `contract`, never `core`/transports.
 *   - `core` may import `db` + `contract`, never transports.
 *   - transports import `core` + `contract`, never `db` or each other.
 *
 * Encoded with the eslint-core `no-restricted-imports` rule (no plugin needed),
 * scoped per source directory via `overrides`. `src/main.ts` is the composition
 * root and is intentionally unrestricted so it may wire db + transports together.
 *
 * Patterns match the relative import specifiers we actually write (`../core/x`,
 * `../../db/y`); `**` spans the leading `..` segments. Brace/extglob `@(...)`
 * forms are avoided — oxlint silently ignores them in `overrides[].files`.
 */
const layerGroups = (layer: string): string[] => [`**/${layer}`, `**/${layer}/**`];

const forbid = (files: string[], layers: string[]): Override => ({
  files,
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: layers.flatMap(layerGroups),
            message: `Layer boundary: ${files[0]} may not import from ${layers.join(", ")} (contract <- db <- core <- transports).`,
          },
        ],
      },
    ],
  },
});

export default defineConfig({
  lint: {
    ignorePatterns: ["dist/**", "node_modules/**"],
    options: {
      // The quality gate: type-aware lint + full type-check, warnings are errors.
      typeAware: true,
      typeCheck: true,
      denyWarnings: true,
      maxWarnings: 0,
    },
    overrides: [
      forbid(["src/db/**"], ["core", "cli", "mcp", "http"]),
      forbid(["src/core/**"], ["cli", "mcp", "http"]),
      forbid(["src/contract/**"], ["db", "core", "cli", "mcp", "http"]),
      forbid(["src/cli/**"], ["db", "mcp", "http"]),
      forbid(["src/mcp/**"], ["db", "cli", "http"]),
      forbid(["src/http/**"], ["db", "cli", "mcp"]),
    ],
  },
});
