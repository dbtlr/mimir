import { defineConfig } from "vite-plus";
import type { OxlintConfig } from "oxlint";

type Override = NonNullable<OxlintConfig["overrides"]>[number];

/**
 * Layer-boundary enforcement.
 *
 * `@mimir/contract` is the dependency-free *type leaf* — its zero-imports rule
 * is structural now (the package has no dependencies), so no override guards
 * it. Inside `@mimir/bin` the flow is `contract ← db ← core ← transports`:
 *   - `db` may import `contract`, never `core`/transports.
 *   - `core` may import `db` + `contract`, never transports.
 *   - transports import `core` + `contract`, never `db` or each other.
 *
 * Encoded with the eslint-core `no-restricted-imports` rule (no plugin needed),
 * scoped per source directory via `overrides`. `main.ts` is the composition
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
  fmt: {
    // machine-written (scripts/generate-ui-assets.ts) and gitignored
    ignorePatterns: ["**/*.generated.ts"],
  },
  lint: {
    ignorePatterns: ["dist/**", "node_modules/**", "**/*.generated.ts"],
    options: {
      // The quality gate: type-aware lint + full type-check, warnings are errors.
      typeAware: true,
      typeCheck: true,
      denyWarnings: true,
      maxWarnings: 0,
    },
    overrides: [
      forbid(["packages/bin/src/db/**"], ["core", "cli", "mcp", "http"]),
      forbid(["packages/bin/src/core/**"], ["cli", "mcp", "http"]),
      forbid(["packages/bin/src/cli/**"], ["db", "mcp", "http"]),
      forbid(["packages/bin/src/mcp/**"], ["db", "cli", "http"]),
      forbid(["packages/bin/src/http/**"], ["db", "cli", "mcp"]),
      // Tests legitimately wire layers together (fixtures from `db/testing`,
      // cross-layer assertions); the boundary constrains shipped code, not tests.
      { files: ["**/*.test.ts"], rules: { "no-restricted-imports": "off" } },
    ],
  },
});
