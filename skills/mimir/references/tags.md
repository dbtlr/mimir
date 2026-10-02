# Tags: the classification layer

## The primitive

A tag is a flat, opaque string attachable to **any work node or artifact**. Mimir
never interprets tag contents — it does set-membership filtering, composed with
structural scope (`-t <tag>` on `list`, `--eq tag:x`, `--missing tag`). A tag
application carries no note on any entity — vault `tags` frontmatter is a plain
string set. `untag` is a plain unlogged delete. Tags are cheap, not
precious — attach freely, remove freely.

```sh
mimir tag KEY-9,KEY-a3 spec v2
mimir untag KEY-9 v2
mimir create task "…" --parent KEY-2 --tag release:v0.3   # tag at creation
mimir list -t release:v0.3 --status all
```

## Two hard rules

1. **Scope is relational, not lexical.** A tag's text carries only what no
   structural filter can: tag `bug` and query `-s API --eq tag:bug`, rather
   than tagging `api-bug`.
2. **A tag carries no rationale.** Tag membership is the whole signal. One-off
   rationale — why _this_ attachment — goes in `annotate`; grouping metadata that
   several entities share goes in a tagged artifact.

## Suggested conventions (conventions, not law)

Mimir mandates no vocabulary; consumers layer their own standards on top. These are
the patterns that have earned their keep:

- `release:v0.3` — release grouping across the tree (membership = a tag query).
- `spec` / `plan` / `session_log` — artifact classification (artifacts have no
  type field; tags are how you find "all session logs").
- Process-once flows: tag `consolidated` when processed, query by absence
  (`--missing tag` scoped to the candidates) to find the unprocessed remainder.
- `area:auth`-style facets, when a project wants a second cutting axis.

**The litmus for inventing a tag: will something ever filter by it?** A tag nobody
queries is prose in the wrong column — put it in an annotation instead.
