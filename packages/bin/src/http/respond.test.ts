import { afterEach, beforeEach, expect, test } from 'bun:test';

import { notFound } from '../core';
import { errorResponse } from './respond';

/**
 * Unit cover for the internal-error fallback (MMR-292): a non-domain throw must
 * ship a synthesized house-voice fact + hint — never the raw library/exception
 * text (output-voice.md) — while the raw detail is preserved for the operator on
 * stderr. Pure `Request` in, `Response` out; no store, so it runs everywhere.
 */

const REQ = new Request('http://localhost/api/tasks/MMR-1', { method: 'POST' });

let logged: string[];
const realError = console.error;
beforeEach(() => {
  logged = [];
  console.error = (...parts: unknown[]) => {
    logged.push(parts.map((p) => String(p)).join(' '));
  };
});
afterEach(() => {
  console.error = realError;
});

type Envelope = { error: { code: string; message: string; hint?: string } };

test('a non-domain Error ships the house-voice envelope, not the raw message', async () => {
  const res = errorResponse(REQ, new Error('ECONNREFUSED 127.0.0.1:5432 sqlite locked'));
  expect(res.status).toBe(500);
  const body = (await res.json()) as Envelope;
  expect(body.error.code).toBe('internal');
  expect(body.error.message).toBe('the request did not complete');
  expect(body.error.hint).toBe("run 'mimir doctor'");
  // The library text appears nowhere in the client-visible envelope.
  expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
  expect(JSON.stringify(body)).not.toContain('sqlite');
});

test('the raw detail is preserved on stderr with request context', () => {
  errorResponse(REQ, new Error('ECONNREFUSED boom'));
  const line = logged.join('\n');
  expect(line).toContain('POST');
  expect(line).toContain('/api/tasks/MMR-1');
  expect(line).toContain('ECONNREFUSED boom');
});

test('a non-Error throw is stringified to stderr, still house voice in the envelope', async () => {
  const res = errorResponse(REQ, 'raw string failure');
  const body = (await res.json()) as Envelope;
  expect(body.error.message).toBe('the request did not complete');
  expect(JSON.stringify(body)).not.toContain('raw string failure');
  expect(logged.join('\n')).toContain('raw string failure');
});

test('embedded newlines in the detail cannot forge extra records in the log', () => {
  errorResponse(REQ, 'line1\n✗ serve: forged record');
  expect(logged).toHaveLength(1);
  // The diagnostic is one JSON payload: control characters stay escaped.
  expect(logged[0]).not.toContain('\n');
  expect(logged[0]).toContain(String.raw`\n`);
  expect(logged[0]).toContain('forged record');
});

test('a MimirError still passes through verbatim (regression)', async () => {
  const res = errorResponse(REQ, notFound('MMR-9 doesn’t exist'));
  expect(res.status).toBe(404);
  const body = (await res.json()) as Envelope;
  expect(body.error.code).toBe('not_found');
  expect(body.error.message).toContain('MMR-9');
  // A domain error is not routed through stderr — it is expected output.
  expect(logged).toHaveLength(0);
});
