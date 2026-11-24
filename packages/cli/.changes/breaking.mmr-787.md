- Add the `seedCounts` facet to a project's record (MMR-787): `{ total, open }`, where `total` counts every seed on the board, settled ones included, and `open` counts the seeds that are neither resolved nor rejected. `mimir get KEY --col seedCounts --format json` carries it as `seed_counts`. The console's project page now draws its Seeds tab from this tally, so the Work, Tasks, and Artifacts tabs no longer load the board's whole seed history every few seconds. The store does not change.

### Migration

**Affected surface.** Clients of the Engine's `getNode` method, the console among them.

**Why.** The project page's Seeds tab needs only how many seeds exist and how many are open, and loading every seed to count them grew with the board's seed history.

**Before and after.** The `facets` list accepts `seedCounts`, and a project read that asks for it carries `seedCounts: { total, open }`. No existing field changes.

**Steps.** Update the host before its clients.

**Validation.** Open a project with seeds in the console against the updated host, and check that the Seeds tab shows with its open count on the Work tab.
