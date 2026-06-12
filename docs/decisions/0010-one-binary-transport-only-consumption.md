---
title: "ADR 0010: One binary, transport-only consumption, monorepo deferred to the UI"
status: accepted
date: 2026-06-04
---

# ADR 0010: One binary, transport-only consumption, monorepo deferred to the UI

How Mimir's surfaces physically ship and how the repo is structured.

## The decision

1. **One binary, not four.** The three server-side surfaces — **CLI**, **MCP server**, **HTTP API** — ship as a single Bun executable with subcommand entry points, sharing the **core** in-process:
   - `mimir <verb>` — CLI (ephemeral; exits)
   - `mimir mcp` — MCP server over stdio (the agent spawns it)
   - `mimir serve` — HTTP API daemon (and, later, host of the built UI's static assets)

2. **Transport-only consumption — no external core library.** Every consumer reaches Mimir through a transport, **never** by importing the core: agents via **MCP**, humans/scripts via the **CLI**, programmatic/UI clients via the **API**. The core is internal to the binary. _(Supersedes design-spec §2's "external consumers — including the active-context loader — call the core directly.")_

3. **The UI is separate, served by the API.** Browser code (its own framework/bundler/deps) can't live in the Bun binary as logic; `mimir serve` hosts it as static assets and the UI talks to the API.

4. **Repo: one package now; monorepo when the UI lands.** Phase 1 is a single package with an internal boundary — `src/core/` (pure, zero transport deps) vs `src/{cli,mcp,http}/` — policed by a lint/import rule. It becomes a **Bun-workspace monorepo** when the web UI arrives; the driver is the **shared contract types** (Task DTO, State word enum, format shapes) the browser needs but the SQLite-bound core can't ship — extracted into a small `contract` package both the binary and the UI consume.

## Why

- **Local-first + single-operator removes the split-binary rationale.** There is no server to deploy independently; everything runs on one machine against one SQLite file. One binary means no version skew between surfaces and one thing to build, version, and distribute.
- **A shared SQLite file wants one DB layer.** With an MCP daemon, a `serve` daemon, and ad-hoc CLI calls all hitting the same file, WAL mode + a busy timeout must be configured once, in a layer all entry points share — which favors one binary.
- **Transport-only keeps the boundary clean and language-agnostic.** Saga is deliberately thin (agent skills + small Python scripts); it has no use for a TS library and consumes Mimir through MCP/API. No cross-language library coupling to maintain.
- **Defer the monorepo because nothing forces it yet.** Workspace machinery before a second build target is the pre-abstraction the project avoids (KISS — minimum complexity for the function). The UI is the first genuine second target, and it brings its own concrete driver (contract types).

## Considered and rejected

- **A separate binary per surface** — independent deployment is the only real reason to split, and it doesn't exist at single-operator/local scale; pure packaging overhead.
- **Core as a published library from day one** — no same-language importer exists; every actual consumer uses a transport. Pre-abstraction.
- **Monorepo from the start** — nothing to share across packages until the UI; premature structure.
- **Letting consumers import the core directly** (spec §2) — couples external tools to Mimir's internals and its language; replaced by transport-only.

## Consequences

- **Phase 1 repo shape:** one package, one binary; `src/core` vs `src/{cli,mcp,http}` with an import-boundary lint rule enforcing "one core, thin transports" structurally.
- **Shared DB layer** owns WAL + busy-timeout pragmas, used by every entry point.
- **Integration map** (for the roadmap and for Saga): agents → MCP; humans/scripts → CLI; programmatic/UI → API. Saga's task create/manage flows are MCP calls.
- **The UI phase** introduces the Bun workspace + a shared `contract`-types package — a roadmap milestone, not built now.
- **Design spec drift:** §2's direct-core-consumption line is superseded; this ADR governs.

## Refinement (2026-06-10 — agents reach the intent envelope CLI-first)

The integration map's "agents → MCP" softens: agents consume the **intent envelope**, and the **CLI driven through the shell is the default rendering for them too** — a skill-equipped agent reads the contract on demand and runs `mimir …`, with zero per-project config and no standing tool-schema context cost. **MCP remains the rendering for hosts that can't shell out** (or where a host-managed server is preferred); the two renderings stay 1:1 by design, so nothing else moves.

Decided while designing the agent skill (`MMR-24`): requiring MCP server config in every workspace is friction against the skill's whole job (cross-workspace dogfooding via one installed binary), and MCP's standing cost (every verb schema in context all session; null-serializing envelopes) loses to skill-based progressive disclosure over the CLI's `--json` contract. Saga's integration line updates accordingly: task flows are CLI invocations unless the host lacks a shell.

## Refinement (2026-06-11 — the concrete workspace shape, at `MMR-15`)

The monorepo this ADR deferred takes the **minimal split**: a private workspace
root with `packages/bin` (`@mimir/bin` — the binary; `db`, `core`, and the
three transports stay internal directories policed by the existing lint
overrides), `packages/contract` (`@mimir/contract` — the type leaf; zero-deps
becomes structural, its lint override drops), and `packages/ui` (`@mimir/ui`,
arriving with the first UI chunk). No `core`/`db` package split — transport-only
consumption means no second consumer exists. Nothing publishes to npm.

`cli` was rejected as the binary package's name: the CLI is one transport of
three, and `packages/cli/src/http` would overload a term the glossary keeps
narrow. The contract package's boundary: today's `src/contract` plus the wire
types every consumer parses — `ErrorCode` and the error-envelope type (moving
from `core`; the `MimirError` class stays behind the transports) and the
`{items}` collection-envelope type (ADR 0012's cursor-room contract, declared
once). Types and `*_VALUES` tuples only — no zod (it remains an MCP-SDK
requirement internal to that transport), no route map, no client SDK.
