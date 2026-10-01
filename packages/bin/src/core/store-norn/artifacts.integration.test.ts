import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { bunExec } from '../../exec';
import { converge } from '../../vault/converge';
import { createScratchpadService } from '../scratchpads/service';
import { NornClient } from './client';
import { createNornWriteStore } from './writer';

const NORN = Bun.which('norn') !== null;
const CREATED = '2026-08-03T12:00:00.000Z';
/** Norn stays silent about a full scan below 1,000 documents; clear that bar. */
const FILLER_ARTIFACTS = 1000;

setDefaultTimeout(60_000);

let root: string;
let client: NornClient;
/** Everything the `norn mcp` subprocess wrote to stderr. */
let nornStderr: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mimir-artifact-lookup-'));
  await converge(root, { allowCreate: true, exec: bunExec });
  // Written straight to disk before the first call: the subprocess indexes the
  // populated vault on spawn, the way a long-lived project vault looks.
  mkdirSync(join(root, 'MMR', 'artifacts'), { recursive: true });
  writeFileSync(
    join(root, 'MMR', 'MMR.md'),
    `---\ntype: project\nname: Mimir\nkey: MMR\nproject: "[[MMR]]"\ncreated: ${CREATED}\nupdated_at: ${CREATED}\n---\n`,
  );
  for (let seq = 1; seq <= FILLER_ARTIFACTS; seq++) {
    writeFileSync(
      join(root, 'MMR', 'artifacts', `MMR-a${String(seq)}.md`),
      `---\ntype: artifact\ntitle: Filler ${String(seq)}\nproject: "[[MMR]]"\ncreated: ${CREATED}\nupdated_at: ${CREATED}\nsource_scratch: 00000000-0000-4000-8000-${String(seq).padStart(12, '0')}\n---\nFrozen.\n`,
    );
  }
  nornStderr = '';
  client = new NornClient({
    transportFactory: () => {
      const transport = new StdioClientTransport({
        args: ['mcp', '--cwd', root],
        command: 'norn',
        stderr: 'pipe',
      });
      transport.stderr?.on('data', (chunk: Buffer) => {
        nornStderr += chunk.toString();
      });
      return transport;
    },
    vaultPath: root,
  });
});

afterEach(async () => {
  await client.close();
  rmSync(root, { force: true, recursive: true });
});

test.skipIf(!NORN)(
  'freezing a scratchpad in a populated vault finds its artifact through an indexed lookup',
  async () => {
    const store = createNornWriteStore(client, root);
    const service = createScratchpadService(store.scratchpads, store.artifacts, store);
    const pad = await service.create({ project: 'MMR', title: 'Shaping record' });

    const artifact = await service.freeze(pad.id, {
      expectedUpdatedAt: pad.updatedAt,
      summary: 'Frozen shaping record',
    });

    expect(await store.artifacts.findBySourceScratch(pad.id)).toEqual(artifact);
    expect(nornStderr).not.toContain('unindexed');
  },
);
