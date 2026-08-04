---
title: 'ADR 0028: Scratchpads use a work-plane noun group'
status: accepted
date: 2026-08-03
---

# ADR 0028: Scratchpads use a work-plane noun group

Scratchpads are the deliberate exception to ADR 0024's flat work-plane grammar:
their CLI lives under `mimir scratch <operation>`, while MCP uses matching
`scratch_*` tool names. A Scratchpad is temporary episode state with a UUID
handle, not a sequenced work entity whose kind is encoded by the ordinary Mimir
id grammar. Grouping its full lifecycle keeps `create`, `update`, `get`, and
`discard` from overloading the established project/node/artifact meanings and
makes the temporary-state boundary visible at every invocation. The namespace
cost is acceptable because these operations form one resumability workflow,
while task and Seed lifecycle verbs remain flat and unchanged.
