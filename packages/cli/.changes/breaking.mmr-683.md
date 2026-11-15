- **Deliver and release an attempt (MMR-683).** Delivery ids accept start, block, unblock, park, unpark, submit, return, and abandon. Land completes every staged member in one transaction; abandon releases live members back to unclaimed todo work while preserving their holds. Delivery history records lifecycle, hold, and release events.

### Migration

**Affected surface.** Engine, tRPC, CLI and MCP.

**Why.** One milestone lands or releases all of an attempt's work atomically.

**Before and after.** The Engine gains nine delivery verb methods. Existing task verbs dispatch delivery ids to those methods. Delivery reasons are required for block, park, and abandon; task start handles and block --on are refused on deliveries.

**Steps.** Update the host before clients and regenerate Engine adapters from the contract snapshot.

**Validation.** Start and submit a delivery, stage its members, and land it. Abandon another delivery and confirm its members return to todo with their holds preserved.
