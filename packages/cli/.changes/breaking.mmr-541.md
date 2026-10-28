- **The `/api` HTTP envelope** (MMR-541). The host no longer serves the resource-shaped `/api` routes, and the `@mimir/api` package, the console's `/api` client, and the `/api` entries in the PWA navigation denylist are gone. The console runs on server functions over the Engine, and remote clients use `/trpc`; every method on `/api` now answers `410` with a JSON `gone` refusal that names `/trpc`, so a stale probe fails instead of passing on the console's HTML. A store-backed health probe reads the Engine instead: `curl --fail --get <host>/trpc/projects --data-urlencode 'input={"json":{}}'` answers `200` with the project list. `/health` is unchanged and still does not query the store. See the [host guide](../../docs/guides/host.md#check-health) and the [refinement to ADR 0012](../../docs/decisions/0012-http-api-true-resource-envelope.md).

### Migration

**Affected surface.** Clients, scripts, and health probes that call the host's `/api` routes.

**Why.** The console runs on server functions over the Engine, and remote clients use `/trpc`.

**Before and after.**

```sh
curl --fail <host>/api/projects
curl --fail --get <host>/trpc/projects --data-urlencode 'input={"json":{}}'
```

**Steps.**

1. Point remote clients at `/trpc`.
2. Replace a store-backed `/api` probe with the `/trpc/projects` call above; `/health` is unchanged and does not query the store.

**Validation.** The `/trpc/projects` probe answers `200` with the project list, and a stale `/api` call answers `410` naming `/trpc`.
