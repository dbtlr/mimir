import { afterEach, beforeEach, expect, test } from 'bun:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type { PostgresTestStore } from '../core/store-postgres/testing';
import { createPgliteTestStore } from '../core/store-postgres/testing';
import { serveStdio } from './server';

/**
 * `serveStdio` owns the MCP session's lifetime: it settles only when the
 * transport closes, because its caller releases the store the moment it
 * returns. A backend that reconnects lazily (the Norn client) hid an early
 * return; a pooled backend surfaces it as "driver has already been destroyed"
 * on the first tool call.
 */
let store: PostgresTestStore;
beforeEach(async () => {
  store = await createPgliteTestStore();
});
afterEach(async () => {
  await store.close();
});

test('serveStdio stays pending while the session is open and settles on close', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });

  let settled = false;
  const serving = (async (): Promise<void> => {
    await serveStdio(store.store, '0.0.0', undefined, serverTransport);
    settled = true;
  })();
  await client.connect(clientTransport);

  // A live session: a tool call works and the serve promise is still open.
  const tools = await client.listTools();
  expect(tools.tools.length).toBeGreaterThan(0);
  await Bun.sleep(20);
  expect(settled).toBe(false);

  await client.close();
  await serving;
  expect(settled).toBe(true);
});
