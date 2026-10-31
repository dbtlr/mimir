- **Blank `--direction` and `--desc` text** (MMR-606). `mimir update` and the Engine refuse a `description` or `next` that is empty or only whitespace, and a seed's `description` too. The refusal is a `validation` error that leaves the stored text unchanged. A blank used to clear the field, and a script whose input file was missing or empty cleared a direction or description that Mimir keeps no earlier version of.
- **`--clear-direction` and `--clear-desc`** (MMR-606). Add the flags that clear a direction or a description. Each is accepted where its text flag is, and passing one with its text flag is a usage error. MCP takes `clear-direction: true` and `clear-desc: true`, and an Engine client sends `null`. The operator console sends `null` when a person saves an emptied editor, and the task edit form can now clear a description.

### Migration

**Affected surface.** Scripts that clear a direction or description with `--direction ""` or `--desc ""`, MCP callers that send a blank `direction` or `desc`, and Engine clients that send a blank `next` or `description`.

**Why.** Clearing prose destroys it for good, and a blank usually comes from an empty script input rather than a decision to clear. Making the clear its own flag turns that mistake into a refusal.

**Before and after.**

```sh
mimir update MMR-4 --direction ""
mimir update MMR-4 --clear-direction

mimir update MMR-7 --desc ""
mimir update MMR-7 --clear-desc
```

**Steps.**

1. Update the host before the clients. A client from before this change that sends a blank is refused, the text survives, and it cannot clear until it is updated. `MIN_CLIENT` does not change.
2. Replace `--direction ""` with `--clear-direction` and `--desc ""` with `--clear-desc` in each script.
3. Change MCP callers to send `clear-direction: true` or `clear-desc: true`. An Engine client sends `null` for `next` or `description`.

**Validation.** Run `mimir update <id> --direction ""` and check that it is refused with a hint that names `--clear-direction`, then run `mimir get <id>` after the clear flag and check that the field is gone.
