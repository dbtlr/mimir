/*
 * A stub push service for tests: a fetch that records each request and
 * answers per endpoint with a status, no answer until the request's signal
 * aborts (`hang`), a network failure (`unreachable`), or a test's own
 * function, which may hold the answer back until the test releases it.
 */

/** How the stub answers one endpoint. */
export type StubPushAnswer =
  | number
  | 'hang'
  | 'unreachable'
  | ((request: StubPushRequest) => Promise<number>);

/** One request the stub received. */
export type StubPushRequest = {
  endpoint: string;
  method: string;
  redirect: RequestRedirect | undefined;
  headers: Record<string, string>;
  body: Uint8Array;
};

/** Reject when the signal aborts, as a real fetch does; never resolve otherwise. */
function untilAborted(signal: AbortSignal | null | undefined): Promise<never> {
  const { promise, reject } = Promise.withResolvers<never>();
  signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  return promise;
}

function bodyBytes(body: RequestInit['body']): Uint8Array {
  if (body instanceof Uint8Array) {
    return body;
  }
  throw new TypeError('the stub push service expects a Uint8Array body');
}

/** A push service answering `answers[endpoint]`, or `fallback` for an endpoint it has none for. */
export function stubPushService(
  answers: Record<string, StubPushAnswer> = {},
  fallback: StubPushAnswer = 201,
) {
  const requests: StubPushRequest[] = [];
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const request: StubPushRequest = {
      body: bodyBytes(init.body),
      endpoint: input,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      method: init.method ?? 'GET',
      redirect: init.redirect,
    };
    requests.push(request);
    const answer = answers[input] ?? fallback;
    if (answer === 'hang') {
      return untilAborted(init.signal);
    }
    if (answer === 'unreachable') {
      throw new TypeError('fetch failed');
    }
    const status = typeof answer === 'number' ? answer : await answer(request);
    return new Response(status === 204 ? null : 'push service body', { status });
  };
  return { answers, fetch, requests };
}

/** A promise a test settles itself. */
export function deferred<T>() {
  const { promise, resolve } = Promise.withResolvers<T>();
  return { promise, resolve };
}
