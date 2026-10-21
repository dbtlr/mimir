/**
 * The pre-credential client for a host (ADR 0038): `/health` and the pairing
 * routes, which take neither a bearer token nor a version header. Everything
 * after pairing goes through RemoteEngine. This module imports no store code.
 */
import { healthSchema, MimirError } from '@mimir/contract';
import type { ErrorCode, Health } from '@mimir/contract';
import { z } from 'zod';

/** What a refusal adds to a MimirError: whether a retry could succeed, and what the host said. */
type HostFailure = {
  /** HTTP status of the answer; absent when no answer arrived. */
  status?: number;
  /** Seconds the host asked the client to wait, from `Retry-After`. */
  retryAfter?: number;
  /** True for a network error, a 5xx, or an answer that is not JSON; a retry may succeed. */
  transient: boolean;
};

/**
 * A refused host request, with its remedy. `transient` separates what a
 * caller may retry (the network, a host fault, a proxy page) from what it
 * must report (a 4xx, an unreadable protocol, a definite pairing state).
 * Messages never carry a token, a poll secret, or any part of a response body.
 */
export class HostRequestError extends MimirError {
  readonly retryAfter?: number;
  readonly status?: number;
  readonly transient: boolean;

  constructor(code: ErrorCode, message: string, hint: string, failure: HostFailure) {
    super(code, message, hint);
    this.name = 'HostRequestError';
    this.retryAfter = failure.retryAfter;
    this.status = failure.status;
    this.transient = failure.transient;
  }
}

/** The fetch a HostClient calls through; tests pass an in-process host. */
export type HostFetch = (input: string, init: RequestInit) => Promise<Response>;

type HostClientOptions = {
  /** The host's origin; any path on the URL is ignored. */
  origin: string;
  fetch?: HostFetch;
  /** Per-request limit before the attempt fails as transient. Defaults to 15 seconds. */
  timeoutMs?: number;
};

/** A filed pairing request. `userCode` is for the operator; `pollSecret` stays on this device. */
export type PairingFiled = {
  userCode: string;
  pollSecret: string;
  /** ISO-8601 instant the request lapses. */
  expiresAt: string;
  /** Seconds to wait between polls, held to {@link MIN_INTERVAL}..{@link MAX_INTERVAL}. */
  interval: number;
  /** The host's clock at filing (epoch milliseconds, from its `Date` header), when it sent one. */
  hostNow?: number;
};

/** A poll's answer. `approved` carries the device token once; the other states end or continue the wait. */
export type PairingAnswer =
  | { status: 'pending' | 'denied' | 'expired' }
  | { status: 'approved'; device: string; token: string };

const filedSchema = z.object({
  expires_at: z.string(),
  interval: z.number().positive(),
  poll_secret: z.string().min(1),
  user_code: z.string().min(1),
});

const answerSchema = z.discriminatedUnion('status', [
  z.object({ status: z.enum(['pending', 'denied', 'expired']) }),
  z.object({ device: z.string().min(1), status: z.literal('approved'), token: z.string().min(1) }),
]);

const conflictSchema = z.object({ error: z.string(), hint: z.string().optional() });

const DEFAULT_TIMEOUT_MS = 15_000;
/** Bounds on the host's poll interval, in seconds: a huge value overflows a timer, a tiny one hammers the host. */
const MIN_INTERVAL = 1;
const MAX_INTERVAL = 60;

/** Which route a request is for, since the same status means different things on each. */
type Route = 'health' | 'request' | 'poll';

/** A client for a host's `/health` and pairing routes. */
export class HostClient {
  readonly origin: string;
  readonly #fetch: HostFetch;
  readonly #timeoutMs: number;

  constructor(options: HostClientOptions) {
    this.origin = new URL(options.origin).origin;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** GET `/health`: the host's build, minimum client, schema, and status. */
  async health(): Promise<Health> {
    return this.#answer('health', await this.#send('/health', undefined), healthSchema);
  }

  /** File a pairing request for `device`; the host trims and validates the name. */
  async requestPairing(device: string): Promise<PairingFiled> {
    const answer = await this.#send('/auth/pairing/requests', { device });
    const filed = this.#answer('request', answer, filedSchema);
    return {
      expiresAt: filed.expires_at,
      ...(answer.hostNow === undefined ? {} : { hostNow: answer.hostNow }),
      interval: Math.min(Math.max(filed.interval, MIN_INTERVAL), MAX_INTERVAL),
      pollSecret: filed.poll_secret,
      userCode: filed.user_code,
    };
  }

  /**
   * Ask whether the request the secret names has been decided. An abort of
   * `signal` ends the request at once, as a transient failure the caller
   * reads against its own signal.
   */
  async pollPairing(pollSecret: string, signal?: AbortSignal): Promise<PairingAnswer> {
    const answer = await this.#send('/auth/pairing/poll', { poll_secret: pollSecret }, signal);
    return this.#answer('poll', answer, answerSchema);
  }

  async #send(path: string, body: object | undefined, abort?: AbortSignal): Promise<Answer> {
    const url = `${this.origin}${path}`;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        ...(body === undefined
          ? { method: 'GET' }
          : {
              body: JSON.stringify(body),
              headers: { 'content-type': 'application/json' },
              method: 'POST',
            }),
        // A followed redirect would resend the device name or poll secret wherever it points.
        redirect: 'manual',
        signal:
          abort === undefined
            ? AbortSignal.timeout(this.#timeoutMs)
            : AbortSignal.any([abort, AbortSignal.timeout(this.#timeoutMs)]),
      });
    } catch {
      // The cause is dropped: a transport error can quote the request it failed on.
      throw new HostRequestError(
        'invariant',
        `could not reach the host at ${this.origin}`,
        'check the host URL and that the host is running, then try again',
        { transient: true },
      );
    }
    const json: unknown = await response.json().catch(() => undefined);
    return {
      hostNow: hostNowOf(response),
      json,
      redirectTo: redirectTargetOf(response),
      retryAfter: retryAfterOf(response),
      status: response.status,
    };
  }

  #answer<T>(route: Route, answer: Answer, schema: z.ZodType<T>): T {
    if (answer.status >= 300 && answer.status < 400) {
      throw this.#redirected(answer);
    }
    if (answer.status === 429 && route === 'request') {
      throw rateLimited(answer);
    }
    if (answer.status === 429 && route === 'health') {
      throw this.#limited(answer);
    }
    // Worth retrying: a 5xx, 408, a poll's 429, and an answer that is no host's (a captive page).
    // Any other 4xx is the host's or its proxy's definite answer, whatever its body.
    const clientError = answer.status >= 400 && answer.status < 500;
    const transient =
      answer.status >= 500 || answer.status === 408 || (answer.json === undefined && !clientError);
    if (transient || (route === 'poll' && answer.status === 429)) {
      throw this.#transient(answer);
    }
    if (answer.status === 200) {
      const parsed = schema.safeParse(answer.json);
      if (parsed.success) {
        return parsed.data;
      }
      throw new HostRequestError(
        'invariant',
        `the answer from ${this.origin} is not one this client understands`,
        'check the URL points at a mimir host, and update the CLI or the host if their versions differ',
        { status: 200, transient: false },
      );
    }
    throw this.#refused(route, answer);
  }

  /** A rate-limited health check: one-shot, so it refuses with the wait rather than retrying. */
  #limited(answer: Answer): HostRequestError {
    const wait =
      answer.retryAfter === undefined ? 'a while' : `${String(answer.retryAfter)} seconds`;
    return new HostRequestError(
      'conflict',
      `the host at ${this.origin} is limiting requests`,
      `try again in ${wait}`,
      { retryAfter: answer.retryAfter, status: 429, transient: false },
    );
  }

  /** A redirect is never followed; only its target's normalized origin is shown. */
  #redirected(answer: Answer): HostRequestError {
    const target = answer.redirectTo;
    return new HostRequestError(
      'invariant',
      `the host at ${this.origin} redirected${target === undefined ? '' : ` to ${target}`}`,
      target === undefined
        ? 'pair with the address the host serves'
        : `if the host now serves ${target}, pair with it: mimir pair ${target}`,
      { status: answer.status, transient: false },
    );
  }

  #transient(answer: Answer): HostRequestError {
    const failure = { retryAfter: answer.retryAfter, status: answer.status, transient: true };
    return answer.status >= 500
      ? new HostRequestError(
          'invariant',
          `the host at ${this.origin} answered ${String(answer.status)}`,
          'the host or a proxy in front of it failed; try again, or check the host logs',
          failure,
        )
      : new HostRequestError(
          'invariant',
          `the answer from ${this.origin} was not a mimir host answer`,
          'check the URL points at the mimir host and not at a proxy or login page',
          failure,
        );
  }

  #refused(route: Route, answer: Answer): HostRequestError {
    const failure = { status: answer.status, transient: false };
    if (answer.status === 400 && route === 'request') {
      return new HostRequestError(
        'validation',
        'the host refused the device name',
        'use a name of 1 to 128 characters with no control characters',
        failure,
      );
    }
    if (answer.status === 400) {
      return new HostRequestError(
        'validation',
        'the host refused the pairing poll',
        'run mimir pair again',
        failure,
      );
    }
    const conflict = answer.status === 409 ? conflictSchema.safeParse(answer.json) : undefined;
    if (conflict !== undefined) {
      return new HostRequestError(
        'conflict',
        conflict.success ? conflict.data.error : 'the host refused the pairing request',
        conflict.success && conflict.data.hint !== undefined
          ? conflict.data.hint
          : 'deny or unpair the device on the host, or wait for the approval to expire',
        failure,
      );
    }
    return new HostRequestError(
      'invariant',
      `the host at ${this.origin} answered ${String(answer.status)} for ${route}`,
      'the host may be too old to support pairing; update the host, then try again',
      failure,
    );
  }
}

type Answer = {
  hostNow: number | undefined;
  json: unknown;
  redirectTo: string | undefined;
  retryAfter: number | undefined;
  status: number;
};

function rateLimited(answer: Answer): HostRequestError {
  const wait = answer.retryAfter === undefined ? 'a while' : `${String(answer.retryAfter)} seconds`;
  return new HostRequestError(
    'conflict',
    'the host has had too many pairing requests',
    `try again in ${wait}`,
    { retryAfter: answer.retryAfter, status: 429, transient: false },
  );
}

/** `Retry-After` as whole seconds; an HTTP date or junk reads as absent. */
function retryAfterOf(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  return value !== null && /^\d+$/.test(value) ? Number(value) : undefined;
}

/** A redirect's `Location` reduced to an http(s) origin, so a hostile header writes no raw text. */
function redirectTargetOf(response: Response): string | undefined {
  const location = response.headers.get('location');
  if (location === null) {
    return undefined;
  }
  try {
    const target = new URL(location, response.url || undefined);
    return target.protocol === 'http:' || target.protocol === 'https:' ? target.origin : undefined;
  } catch {
    return undefined;
  }
}

/** The host's `Date` header as epoch milliseconds; junk reads as absent. */
function hostNowOf(response: Response): number | undefined {
  const value = response.headers.get('date');
  const at = value === null ? Number.NaN : Date.parse(value);
  return Number.isNaN(at) ? undefined : at;
}
