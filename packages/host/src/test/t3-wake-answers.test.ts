import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { T3WakeInput, T3WakeState } from '../api/fns/deliveries';
import { announceWake } from '../components/t3-wake-answers';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

const ORIGIN = 'https://t3.example';
const RETRY: T3WakeInput = {
  action: 'deliveryPark',
  attempt: 'attempt-0000000001',
  decision: null,
  delivery: 'MMR-d3',
  since: '2026-11-16T09:10:02.310Z',
};

afterEach(() => {
  vi.clearAllMocks();
});

type ToastOptions = {
  action?: { label: string; onClick: () => void };
  cancel?: { label: string; onClick: () => void };
};

function announce(wake: T3WakeState, origin: string | null = ORIGIN) {
  const context = {
    openConnections: vi.fn(),
    origin,
    reconnect: vi.fn(),
    retry: vi.fn(),
  };
  announceWake(wake, context);
  return context;
}

/** The one warning the wake raised: its message and the options it carried. */
function warned() {
  expect(toast.warning).toHaveBeenCalledOnce();
  const [message, options] = vi.mocked(toast.warning).mock.calls[0] ?? [];
  return { message, options: options as ToastOptions | undefined };
}

describe('announceWake (ADR 0040, the wake)', () => {
  it.each<T3WakeState>([{ state: 'sent' }, { reason: 'no_thread', state: 'skipped' }])(
    '%j says nothing',
    (wake) => {
      announce(wake);
      expect(toast.warning).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    },
  );

  it('unreachable: says the thread was not told, and Retry resends the state’s retry', () => {
    const context = announce({ retry: RETRY, state: 'unreachable' });
    const { message, options } = warned();
    expect(message).toBe('Saved. The T3 thread was not told: T3 did not answer.');
    expect(options?.action?.label).toBe('Retry');
    options?.action?.onClick();
    expect(context.retry).toHaveBeenCalledWith(RETRY);
  });

  it('failed: offers Retry with no cause', () => {
    const context = announce({ retry: RETRY, state: 'failed' });
    const { message, options } = warned();
    expect(message).toBe('Saved. The T3 thread was not told.');
    options?.action?.onClick();
    expect(context.retry).toHaveBeenCalledWith(RETRY);
  });

  it('disconnected: offers Reconnect T3', () => {
    const context = announce({ reason: 'expired', state: 'disconnected' });
    const { message, options } = warned();
    expect(message).toBe('Saved. The T3 thread was not told: connect T3 again.');
    expect(options?.action?.label).toBe('Reconnect T3');
    options?.action?.onClick();
    expect(context.reconnect).toHaveBeenCalledOnce();
  });

  it('misconfigured: links to Connections', () => {
    const context = announce({
      problem: 'missing',
      setting: 'MIMIR_SECRET_KEY',
      state: 'misconfigured',
    });
    const { message, options } = warned();
    expect(message).toBe('Saved. The T3 thread was not told: T3 is not set up correctly.');
    expect(options?.action?.label).toBe('Connections');
    options?.action?.onClick();
    expect(context.openConnections).toHaveBeenCalledOnce();
  });

  it('refused: names full access, opens the refused thread, and offers Reconnect T3', () => {
    const open = vi.spyOn(globalThis, 'open').mockReturnValue(null);
    const context = announce({ state: 'refused', thread: { host: 'env-1', session: 'thread-1' } });
    const { message, options } = warned();
    expect(message).toContain('T3 refused the message');
    expect(message).toContain('full access');
    expect(options?.action?.label).toBe('Open in T3');
    options?.action?.onClick();
    expect(open).toHaveBeenCalledWith('t3code://threads/env-1/thread-1', '_self');
    options?.cancel?.onClick();
    expect(context.reconnect).toHaveBeenCalledOnce();
    open.mockRestore();
  });

  it('invalid: raises an error toast naming the field', () => {
    announce({ field: 'decision', state: 'invalid' });
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledOnce();
    expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toContain('decision');
  });
});
