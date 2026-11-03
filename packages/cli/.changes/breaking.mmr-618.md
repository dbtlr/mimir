- **A task in review shows and sorts by when it was submitted** (MMR-618). Its _Now_ row in the console reads _In review · submitted 2h ago_, timed from its latest move into review, so a task sent back and resubmitted counts from the resubmit. The review page lists _Now_ by each row's latest move: a review's submit time, otherwise its start or reservation time. A task that ran for days and was just submitted now sorts near the top instead of near the bottom. The work page and review reports' `now` rows gain `submittedAt`, the time of the latest submit for a task under review and `null` for a queued or in-progress task. `startedAt` keeps its meaning.

### Migration

**Affected surface.** Engine clients that read the work page or review report's `now` rows, and a host serving a console of this release.

**Why.** The new `submittedAt` output field changes the Engine contract. The change is additive, so an older client ignores the field.

**Before and after.**

```json
{ "startedAt": "2026-10-01T09:00:00.000Z", "task": { "status": "under_review" } }
{ "startedAt": "2026-10-01T09:00:00.000Z", "submittedAt": "2026-10-03T17:00:00.000Z", "task": { "status": "under_review" } }
```

**Steps.**

1. Update the host before its clients, as for every Engine change.

**Validation.** Open the console's review page and check that a task under review reads _In review · submitted_ with the time it was last submitted.
