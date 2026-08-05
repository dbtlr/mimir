---
title: 'ADR 0029: Date queries use caller timezone context'
status: accepted
date: 2026-08-04
---

# ADR 0029: Date queries use caller timezone context

Mimir stores and returns machine-readable timestamps as canonical instants:
ISO-8601 UTC strings with millisecond precision and an explicit `Z`. Offsets may
be accepted at input boundaries, but are normalized rather than preserved.
Canonical representation keeps lexical ordering chronological and gives CLI
structured output, MCP, HTTP, and persisted documents one machine contract.

A bare `YYYY-MM-DD` is a human calendar value, not a UTC interval. It is resolved
through one request-wide IANA timezone supplied by the caller, including the
real 23-, 24-, or 25-hour boundaries created by timezone rules. The CLI uses the
invoking system's IANA timezone by default and accepts an explicit override;
browser clients send their detected timezone; MCP and HTTP callers must provide
one whenever a query contains a bare date. A timestamp containing a time must
carry `Z` or a numeric UTC offset. Zone-less timestamps are rejected rather than
silently interpreted as UTC or host-local time.

All resources use one field-qualified date-filter grammar. The positive
operators are `on`, `before`, `after`, `at-or-before`, and `at-or-after`:

- `on` accepts only a bare date and selects its caller-local calendar window.
- For a bare date, `before` selects instants before the opening boundary and
  `at-or-after` selects from that boundary onward; `after` selects from the next
  day's opening boundary onward and `at-or-before` selects instants before that
  boundary. Calendar windows are half-open and never synthesize a final
  millisecond.
- For a timestamp, `before` and `after` are strict while `at-or-before` and
  `at-or-after` include the supplied instant.
- The other operators accept either a bare date or an explicitly zoned
  timestamp. Accepted timestamps use `T`, require hours and minutes, may include
  seconds and a fractional part, and are normalized immediately.

The artifact-only `since`/`before` grammar and the generic `not-before` and
`not-after` names are removed rather than retained as aliases. Date resolution
and comparison live in one core implementation; transports provide raw filters
and caller timezone context without independently performing date arithmetic.
This is an intentional pre-1.0 breaking change with no UTC compatibility
fallback for ambiguous input.

Human-facing output is always rendered in the human's local timezone and biases
toward locale-friendly readability. Absolute values show a timezone abbreviation
or offset; dense surfaces may use relative time. This applies to both the console
and human CLI formats. Machine formats remain canonical UTC because they are
values for computation rather than presentation.

## Consequences

- Query syntax, timezone propagation, and date comparison must change together
  across CLI, MCP, HTTP, and console clients.
- Persisted timestamps become a strict canonical-form invariant. Schema
  convergence and `doctor` may normalize valid zoned variants; malformed or
  zone-less stored values require explicit correction because their intended
  instant cannot be inferred safely.
- Human presentation and persisted-data enforcement can ship as independent
  follow-ups after the shared query contract, keeping each review boundary
  independently verifiable.

## Considered and rejected

- **UTC-aligned bare dates** — deterministic but contradict the calendar used by
  the person writing and reading the query, especially near midnight.
- **One configured operator timezone** — insufficient for callers in different
  locations and for remote clients; the query author's context is authoritative.
- **Transport-specific parsing** — preserves the drift that produced two date
  grammars and incompatible meanings of `before`.
- **Preserving input offsets** — an offset is neither an IANA timezone nor useful
  identity once the instant is known; retaining it creates representational
  variance without retaining daylight-saving intent.
