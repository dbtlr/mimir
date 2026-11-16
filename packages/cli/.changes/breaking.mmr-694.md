- **Include decisions and stopped deliveries in Needs you (MMR-694).** The console uses one ordered set and count across review, alerts, focus queues, and work pages.

### Migration

**Affected surface.** Console Engine reports and their tRPC contract.

**Why.** Stopped deliveries and provisional decisions also wait on the operator.

**Before and after.** Review `decisions` becomes `needsYou`, project counts use
`needsYou`, and review groups and work reports carry tagged `delivery`,
`decision`, and `task` rows. The focus queue carries `{ kind, id }` entries.

**Steps.** Upgrade the host before clients. Regenerate adapters from the contract
snapshot. MIN_CLIENT stays at the current minor’s floor.

**Validation.** Open review or a work page and check the Needs you set.
