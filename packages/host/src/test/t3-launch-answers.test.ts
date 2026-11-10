import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { T3LaunchInput, T3LaunchResult } from '../api/fns/t3';
import { announceLaunch } from '../components/t3-launch-answers';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const ORIGIN = 'https://t3.example';
const LINK = 't3code://threads/env-1/thread-1';
const input = { task: 'MMR-9' } as T3LaunchInput;
const LAUNCHED: T3LaunchResult = {
  environmentId: 'env-1',
  label: 'Valhalla',
  state: 'launched',
  threadId: 'thread-1',
};

afterEach(() => {
  vi.clearAllMocks();
});

type ToastOptions = {
  action?: { label: string; onClick: () => void };
  cancel?: { label: string; onClick: () => void };
};

function announce(answer: T3LaunchResult) {
  const retry = vi.fn();
  announceLaunch(answer, input, { origin: ORIGIN, retry });
  return retry;
}

/** The one toast the answer raised: its message and the options it carried. */
function raised(fn: typeof toast.error | typeof toast.success) {
  expect(fn).toHaveBeenCalledOnce();
  const [message, options] = vi.mocked(fn).mock.calls[0] ?? [];
  return { message, options: options as ToastOptions | undefined };
}

describe('announceLaunch (ADR 0040, Launch)', () => {
  it('launched: names the system and the task, and offers Open in T3', () => {
    const open = vi.spyOn(globalThis, 'open').mockReturnValue(null);
    announce(LAUNCHED);
    const { message, options } = raised(toast.success);
    expect(message).toBe('Launched on Valhalla. MMR-9 is queued.');
    expect(options?.action?.label).toBe('Open in T3');
    options?.action?.onClick();
    expect(open).toHaveBeenCalledWith(LINK, '_self');
    expect(toast.error).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it('not_queued: carries the message, Retry as the action, and Open in T3 as the second button', () => {
    const retry = announce({ ...LAUNCHED, message: 'no longer ready', state: 'not_queued' });
    const { message, options } = raised(toast.error);
    expect(message).toBe(
      'The thread started on Valhalla, but MMR-9 was not queued: no longer ready',
    );
    expect(options?.action?.label).toBe('Retry');
    options?.action?.onClick();
    expect(retry).toHaveBeenCalledOnce();
    expect(options?.cancel?.label).toBe('Open in T3');
  });

  it('unreachable: says T3 did not answer, with Retry and no Open in T3', () => {
    const retry = announce({ state: 'unreachable' });
    const { message, options } = raised(toast.error);
    expect(message).toBe('T3 did not answer.');
    expect(options?.action?.label).toBe('Retry');
    options?.action?.onClick();
    expect(retry).toHaveBeenCalledOnce();
    expect(options?.cancel).toBeUndefined();
  });

  it.each<[string, T3LaunchResult, string, string | undefined]>([
    [
      'a T3 thread with handles',
      { harness: 't3', host: 'env-9', session: 'th-9', state: 'taken' },
      'Already queued for a T3 thread',
      'Open in T3',
    ],
    [
      'a T3 thread without handles',
      { harness: 't3', host: null, session: null, state: 'taken' },
      'Already queued for a T3 thread',
      undefined,
    ],
    [
      'another harness with handles',
      { harness: 'claude', host: 'env-9', session: 'th-9', state: 'taken' },
      'Already queued for another session',
      undefined,
    ],
    [
      'another harness without a host',
      { harness: 'claude', host: null, session: 's', state: 'taken' },
      'Already queued for another session',
      undefined,
    ],
  ])(
    'taken by %s: says who holds it, and offers Open in T3 only for a T3 thread it can link',
    (_name, answer, words, actionLabel) => {
      announce(answer);
      expect(toast.error).toHaveBeenCalledOnce();
      const [message, options] = vi.mocked(toast.error).mock.calls[0] ?? [];
      expect(message).toBe(words);
      expect((options as ToastOptions | undefined)?.action?.label).toBe(actionLabel);
    },
  );

  it.each<[string, T3LaunchResult, string]>([
    ['not_ready', { state: 'not_ready' }, 'This task can no longer be launched'],
    [
      'invalid model',
      { field: 'model', state: 'invalid' },
      'T3’s options changed; check the settings',
    ],
    [
      'invalid environmentId',
      { field: 'environmentId', state: 'invalid' },
      'T3’s options changed; check the settings',
    ],
    [
      'invalid branch',
      { field: 'branch', state: 'invalid' },
      'The branch name is not valid. T3’s options did not change.',
    ],
    [
      'invalid attempt',
      { field: 'attempt', state: 'invalid' },
      'This launch could not be sent; launch again',
    ],
    ['refused', { state: 'refused' }, 'T3 refused the launch'],
    [
      'misconfigured',
      { problem: 'unset', setting: 'MIMIR_URL', state: 'misconfigured' },
      'T3 is not set up: MIMIR_URL is unset.',
    ],
    ['unconfigured', { state: 'unconfigured' }, 'T3 is not configured.'],
    [
      'disconnected',
      { reason: 'expired', state: 'disconnected' },
      'The T3 connection ended. Reconnect T3 to launch.',
    ],
  ])('%s: a plain error with no Retry', (_state, answer, words) => {
    announce(answer);
    expect(toast.error).toHaveBeenCalledOnce();
    expect(toast.error).toHaveBeenCalledWith(words);
    expect(toast.success).not.toHaveBeenCalled();
  });
});
