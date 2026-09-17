import type { NornClient } from './client';
import { createRawDocument } from './raw-write';

/**
 * Seed a document directly at a FIXED path (MMR-281) — the fixture-seeding
 * replacement for the retired `vault.new` RPC (`newDoc` had zero production
 * callers; only test fixtures seeded through it). Every caller here wants a
 * physical sibling/collider/hand-corrupt doc the typed store API can't produce,
 * so this bypasses every store and writes raw.
 *
 * A thin wrapper over {@link createRawDocument}, the production whole-document
 * write primitive the store import shares (MMR-378): the fixture path and the
 * import path must put bytes on disk the same way, or a fixture would prove
 * nothing about the real writer. It keeps this name and its `(frontmatter,
 * body)` argument order only because the fixtures read better that way.
 */
export async function seedRawDoc(
  client: NornClient,
  vaultRoot: string,
  path: string,
  frontmatter: Record<string, unknown>,
  body = '',
): Promise<void> {
  await createRawDocument(client, vaultRoot, { body, frontmatter, path });
}
