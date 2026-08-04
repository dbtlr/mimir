import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { parseJson } from '@mimir/helpers';
import type { Server } from 'bun';

import {
  createInitiative,
  createPhase,
  createProject,
  createScratchpadService,
  createTask,
} from '../core';
import type { Store } from '../core';
import { createTestStore, nodeIdOf, projectIdOf } from '../testing/store';
import { createServer } from './server';

const NORN = Bun.which('norn') !== null;

type Rec = Record<string, unknown>;

describe.skipIf(!NORN)('/api/scratchpads', () => {
  let store: Store;
  let closeStore: () => Promise<void>;
  let server: Server<undefined>;
  let base: string;
  let linkedWork: string;

  beforeEach(async () => {
    ({ close: closeStore, store } = await createTestStore());
    await createProject(store, { key: 'MMR', name: 'Mimir' });
    const projectId = await projectIdOf(store, 'MMR');
    const initiative = await createInitiative(store, {
      projectId,
      title: 'Scratchpad arc',
    });
    const initiativeId = await nodeIdOf(store, `MMR-${String(initiative.seq)}`);
    const phase = await createPhase(store, {
      parentId: initiativeId,
      title: 'HTTP',
    });
    const phaseId = await nodeIdOf(store, `MMR-${String(phase.seq)}`);
    const task = await createTask(store, {
      parentId: phaseId,
      title: 'Parity',
    });
    linkedWork = `MMR-${String(task.seq)}`;
    await createProject(store, { key: 'NRN', name: 'Norn' });
    server = createServer(store, { port: 0, version: '0.0.0-test' });
    base = `http://127.0.0.1:${String(server.port)}`;
  });

  afterEach(async () => {
    await server.stop(true);
    await closeStore();
  });

  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      method,
    });

  const parse = async (response: Response): Promise<Rec> => parseJson<Rec>(await response.text());

  test('serves the working mutation lifecycle with optimistic concurrency', async () => {
    const createdResponse = await send('POST', '/api/scratchpads', {
      linked_work: [],
      project: 'MMR',
      title: 'HTTP parity',
    });
    expect(createdResponse.status).toBe(201);
    let receipt = await parse(createdResponse);
    const id = String(receipt.id);
    expect(receipt).toMatchObject({
      open_agenda: 0,
      project: 'MMR',
      title: 'HTTP parity',
    });

    await send('POST', '/api/scratchpads', {
      project: 'NRN',
      title: 'Other board',
    });
    expect(await parse(await fetch(`${base}/api/scratchpads?project=MMR`))).toMatchObject({
      total: 1,
    });
    expect(await parse(await fetch(`${base}/api/scratchpads?project=all`))).toMatchObject({
      total: 2,
    });

    const supersededToken = String(receipt.updated_at);
    receipt = await parse(
      await send('PATCH', `/api/scratchpads/${id}`, {
        expected_updated_at: receipt.updated_at,
        linked_work: [linkedWork],
        title: 'Renamed',
      }),
    );
    const stale = await send('POST', `/api/scratchpads/${id}/checkpoints`, {
      content: 'stale write',
      expected_updated_at: supersededToken,
    });
    expect(stale.status).toBe(400);

    receipt = await parse(
      await send('POST', `/api/scratchpads/${id}/checkpoints`, {
        content: 'first checkpoint',
        expected_updated_at: receipt.updated_at,
      }),
    );
    const agendaResponse = await send('POST', `/api/scratchpads/${id}/agenda`, {
      content: 'settle this',
      expected_updated_at: receipt.updated_at,
    });
    expect(agendaResponse.status).toBe(200);
    receipt = await parse(agendaResponse);
    expect(receipt.open_agenda).toBe(1);
    receipt = await parse(
      await send('POST', `/api/scratchpads/${id}/agenda/1/complete`, {
        expected_updated_at: receipt.updated_at,
      }),
    );
    receipt = await parse(
      await send('POST', `/api/scratchpads/${id}/agenda`, {
        content: 'replace this',
        expected_updated_at: receipt.updated_at,
      }),
    );
    receipt = await parse(
      await send('POST', `/api/scratchpads/${id}/agenda/2/supersede`, {
        expected_updated_at: receipt.updated_at,
        reason: 'better path',
      }),
    );

    const detail = await parse(await fetch(`${base}/api/scratchpads/${id}`));
    expect(detail).toMatchObject({
      agenda: [
        { content: 'settle this', number: 1, reason: null, state: 'done' },
        {
          content: 'replace this',
          number: 2,
          reason: 'better path',
          state: 'superseded',
        },
      ],
      journal: [{ content: 'first checkpoint', number: 1 }],
      linked_work: [linkedWork],
      title: 'Renamed',
    });

    const frozen = await parse(
      await send('POST', `/api/scratchpads/${id}/freeze`, {
        expected_updated_at: receipt.updated_at,
        summary: 'durable outcome',
        tags: ['http'],
      }),
    );
    expect(frozen).toMatchObject({
      id: 'MMR-a1',
      linked_work: [linkedWork],
      summary: 'durable outcome',
      tags: ['scratchpad', 'http'],
      title: 'Renamed',
    });
    expect((await fetch(`${base}/api/scratchpads/${id}`)).status).toBe(404);
  });

  test('keeps Overview parity and rejects unknown mutation fields', async () => {
    const receipt = await parse(
      await send('POST', '/api/scratchpads', {
        linked_work: [],
        project: 'MMR',
        title: 'HTTP parity',
      }),
    );
    const id = String(receipt.id);
    const overview = await parse(await fetch(`${base}/api/projects/MMR/overview`));
    expect(overview.active_scratchpads).toEqual({
      count: 1,
      scratchpads: [
        {
          id,
          linked_work: [],
          open_agenda: 0,
          project: 'MMR',
          state: 'active',
          title: 'HTTP parity',
          updated_at: receipt.updated_at,
        },
      ],
    });

    const unknown = await send('PATCH', `/api/scratchpads/${id}`, {
      expected_updated_at: receipt.updated_at,
      lifecycle: 'done',
    });
    expect(unknown.status).toBe(400);
    expect((await parse(unknown)).error).toMatchObject({ code: 'validation' });
  });

  test('preserves linked work when PATCH updates only the title', async () => {
    const created = await parse(
      await send('POST', '/api/scratchpads', {
        linked_work: [linkedWork],
        project: 'MMR',
        title: 'Original',
      }),
    );
    const id = String(created.id);
    const updated = await parse(
      await send('PATCH', `/api/scratchpads/${id}`, {
        expected_updated_at: created.updated_at,
        title: 'Renamed',
      }),
    );
    expect(updated).toMatchObject({ id, title: 'Renamed' });
    expect(await parse(await fetch(`${base}/api/scratchpads/${id}`))).toMatchObject({
      linked_work: [linkedWork],
      title: 'Renamed',
    });
  });

  test('refuses unsafe discard and permits an explicit forced discard', async () => {
    let receipt = await parse(
      await send('POST', '/api/scratchpads', {
        project: 'MMR',
        title: 'Discard me',
      }),
    );
    const id = String(receipt.id);
    receipt = await parse(
      await send('POST', `/api/scratchpads/${id}/agenda`, {
        content: 'still open',
        expected_updated_at: receipt.updated_at,
      }),
    );

    expect(
      (
        await send('DELETE', `/api/scratchpads/${id}`, {
          expected_updated_at: receipt.updated_at,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send('DELETE', `/api/scratchpads/${id}`, {
          expected_updated_at: receipt.updated_at,
          force: true,
        })
      ).status,
    ).toBe(400);

    const discarded = await send('DELETE', `/api/scratchpads/${id}`, {
      expected_updated_at: receipt.updated_at,
      force: true,
      reason: 'episode cancelled',
    });
    expect(discarded.status).toBe(200);
    expect(await parse(discarded)).toEqual({ id, result: 'discarded' });
    expect((await fetch(`${base}/api/scratchpads/${id}`)).status).toBe(404);
  });

  test('surfaces a staged freeze and completes it on retry after artifact failure', async () => {
    await server.stop(true);
    const originalArtifacts = store.artifacts;
    let failCreate = true;
    const artifacts = new Proxy(originalArtifacts, {
      get(target, property, receiver) {
        if (property === 'create') {
          return async (...args: Parameters<typeof target.create>) => {
            if (failCreate) {
              failCreate = false;
              throw new Error('injected artifact failure');
            }
            return target.create(...args);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    server = createServer({ ...store, artifacts }, { port: 0, version: '0.0.0-test' });
    base = `http://127.0.0.1:${String(server.port)}`;

    const created = await createScratchpadService(store.scratchpads, store.artifacts, store).create(
      {
        project: 'MMR',
        title: 'Recover freeze',
      },
    );
    const errorLog = spyOn(console, 'error').mockReturnValue(undefined);
    const failed = await send('POST', `/api/scratchpads/${created.id}/freeze`, {
      expected_updated_at: created.updatedAt,
      summary: 'retry me',
    });
    errorLog.mockRestore();
    expect(failed.status).toBe(500);

    const staged = await parse(await fetch(`${base}/api/scratchpads/${created.id}`));
    expect(staged.freezing_at).not.toBeNull();
    const recovered = await send('POST', `/api/scratchpads/${created.id}/freeze`, {
      expected_updated_at: staged.updated_at,
      summary: 'retry me',
    });
    expect(recovered.status).toBe(200);
    expect(await parse(recovered)).toMatchObject({
      id: 'MMR-a1',
      summary: 'retry me',
    });
  });
});
