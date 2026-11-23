- Add `needsYouFacts` to the Engine's `review` report (MMR-721): for each delivery the Needs you deck shows, its title and its phase's ID and title, and for each set of provisional decisions, the tasks they link that are not abandoned. The store does not change.

### Migration

**Affected surface.** Clients of the Engine's `review` method, the console among them.

**Why.** The Needs you deck names a bundle's delivery, phase, and tasks, which the needs-you rows do not carry.

**Before and after.** The `review` report has `needsYou`, `queue`, and the other sections. It now also has `needsYouFacts: { deliveries, bundles }`. No existing field changes.

**Steps.** Update the host before its clients. A client that builds `review` reports, such as a test fixture, adds `needsYouFacts: { bundles: [], deliveries: [] }`.

**Validation.** Open the console against the updated host and check that the review page loads.
