- **Read delivery progress in the console (MMR-680).** Delivery pages show the stop reason, open decisions and answers taken, member progress, follow-up checklists, known limitations, declined findings, and recent journal entries. Phase pages link their live deliveries.

### Migration

**Affected surface.** The console Engine namespace and its tRPC contract.

**Why.** Operators need a read-only view of a delivery’s progress and pending decisions.

**Before and after.** The additive `console.deliveryPage` and
`console.phaseDeliveries` reads assemble read-only delivery pages and cards.

**Steps.** Upgrade the host before clients. Regenerate Engine adapters from the
contract snapshot when maintaining an adapter.

**Validation.** Open a delivery at `/p/KEY/dN` or follow its card from a phase.
