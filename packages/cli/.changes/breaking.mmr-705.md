- Add optional `decide --detail "N: text"` (repeatable, also MCP `detail`) and aligned `option_details` on every decision read. Store and transfer schemas advance to 22 and 15.
- Show an option's detail under its text in the console decisions walkthrough: dim, line breaks kept, clamped to two lines (three at `md` and up) until the option is selected. The radio's name stays the option's text, and `aria-describedby` carries the detail.

### Migration

**Affected surface.** Engine `decide` inputs, decision read records, and store exports.

**Why.** An option can carry context without changing its concise answer text.

**Before and after.** Decision records gain required `option_details`, an aligned list of nonblank text or null. Engine `decide` accepts the list optionally. Exports carry null when no option has a detail.

**Steps.** Add the aligned list to decision fixtures and consumers that construct records. Upgrade the store owner to apply migration 0022. Existing commands need no changes.

**Validation.** Record a decision with `--detail "2: Context"`, then check that `get` pairs the detail with option 2 and that export/import preserves it.
