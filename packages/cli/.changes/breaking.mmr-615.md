- **A task under review is work in flight, not a decision** (MMR-615). The console's _Needs you_ no longer lists tasks under review: not on a work page, the review page, the top-bar alert and its popover, the project health strip, or the focus queue. A review shows in _Now_ as _In review_, and the task page keeps _Approve_ and _Send back…_ in its verdict block, without the attention hue. The review gate itself, such as a pull request's review request, asks for the operator when it needs them. The work page and review reports' needs-you `reason` drops `under_review`, and their `now` rows and in-flight counts include tasks under review.

### Migration

**Affected surface.** Engine clients that read the work page or review report and expect a needs-you or decision row with reason `under_review`, and workflows that rely on the console's _Needs you_ to tell the operator a review is waiting.

**Why.** A review gate is often settled without the operator, by automated reviewers and checks and then a merge by the agent that owns the task. Listing every review as a decision filled _Needs you_ with work that nothing asked the operator to move.

**Before and after.**

```text
Before: mimir submit MMR-9  → Needs you: MMR-9 · In review   (Approve · Send back…)
After:  mimir submit MMR-9  → Now:       MMR-9 · In review · started 2h ago
```

**Steps.**

1. Update the host before the clients. `MIN_CLIENT` does not change.
2. In an Engine client, read tasks under review from the work page or review report's `now` rows, and stop handling a needs-you `reason` of `under_review`.
3. Where the operator must review or merge, ask through the review gate, for example by requesting their review on the pull request.

**Validation.** Submit a task and check that the console lists it under _Now_ as _In review_ and not under _Needs you_, and that its task page still offers _Approve_ and _Send back…_.
