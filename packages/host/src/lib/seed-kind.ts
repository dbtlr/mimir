import type { SeedKind } from '@mimir/contract';

/**
 * Kind tint (MMR-247) — one shared wash-and-inset-ring per seed kind, the
 * `PRIORITY_WASH` idiom (ADR 0019 §1: low-alpha fill + hairline ring, never a
 * solid fill). Reuses the existing status hue tokens so both themes read
 * correctly by translation (§7): bug → the blocked red, idea → the in-progress
 * amber, feature → the ready blue. The consuming element supplies the base
 * `inset-ring`; this map only sets the fill, ring colour, and text tone.
 */
export const SEED_KIND_WASH: Record<SeedKind, string> = {
  bug: 'bg-status-blocked/12 inset-ring-status-blocked/24 text-status-blocked-foreground',
  feature: 'bg-status-ready/12 inset-ring-status-ready/24 text-status-ready-foreground',
  idea: 'bg-status-in-progress/12 inset-ring-status-in-progress/24 text-status-in-progress-foreground',
};
