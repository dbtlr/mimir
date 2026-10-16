---
description: Canonical terms for Mimir's client and host boundary.
---

# Mimir glossary

This glossary defines the client and host boundary terms used in
[ADR 0034](decisions/0034-engine-interface-and-trpc-wire.md) and
[ADR 0035](decisions/0035-tanstack-start-container-host.md).

**Host**: The Mimir server that serves the operator console and remote clients
and owns their shared store.

**Store owner**: The sole Mimir authority for a store, either a local CLI or
one host. Remote clients access a host-owned store through that host.
