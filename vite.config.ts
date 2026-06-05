import { defineConfig } from "vite-plus";
import type { OxlintConfig } from "oxlint";

type Override = NonNullable<OxlintConfig["overrides"]>[number];

/**
 * Layer-boundary enforcement: `db < core < contract < transports`.
 *
 * Encoded with the eslint-core `no-restricted-imports` rule (no plugin needed),
 * scoped per source directory via `overrides`. Each rule forbids importing
 * *upward or sideways* across the layering. `src/main.ts` is the composition
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
            message: `Layer boundary: ${files[0]} may not import from ${layers.join(", ")} (db < core < contract < transports).`,
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
      forbid(["src/db/**"], ["core", "contract", "cli", "mcp", "http"]),
      forbid(["src/core/**"], ["cli", "mcp", "http"]),
      forbid(["src/contract/**"], ["db", "core", "cli", "mcp", "http"]),
      forbid(["src/cli/**"], ["db", "mcp", "http"]),
      forbid(["src/mcp/**"], ["db", "cli", "http"]),
      forbid(["src/http/**"], ["db", "cli", "mcp"]),
    ],
  },
});
