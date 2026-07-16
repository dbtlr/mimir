import { applyReportOutcome } from './apply-report';
import type { NornClient } from './client';
import { createDocumentPlan } from './plan';

/**
 * Seed a document directly at a FIXED path via `create_document` (MMR-281) —
 * the fixture-seeding replacement for the retired `vault.new` RPC (`newDoc`
 * had zero production callers; only test fixtures seeded through it). Every
 * caller here wants a physical sibling/collider/hand-corrupt doc the typed
 * store API can't produce, so this bypasses every store and writes raw.
 * Throws if the write did not apply — a fixture collision must fail the test
 * loud rather than silently leaving the vault in an unexpected shape.
 */
export async function seedRawDoc(
  client: NornClient,
  vaultRoot: string,
  path: string,
  frontmatter: Record<string, unknown>,
  body = '',
): Promise<void> {
  const plan = createDocumentPlan(vaultRoot, path, frontmatter, body);
  const outcome = applyReportOutcome(await client.applyPlan(plan, true));
  if (outcome !== 'applied') {
    throw new Error(`fixture seed at ${path} did not apply: ${String(outcome)}`);
  }
}
