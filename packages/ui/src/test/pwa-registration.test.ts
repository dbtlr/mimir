import type { RegisterSWOptions } from 'virtual:pwa-register';
import { describe, expect, it, vi } from 'vitest';

import { createPwaRegistrationAdapter } from '../lib/pwa-registration';
import type { PwaRegistrationEnvironment } from '../lib/pwa-registration';

class FakeChannel extends EventTarget {
  close = vi.fn();
  postMessage = vi.fn();
}

function fixture(initiallyControlled = true, channel?: FakeChannel) {
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget();
  const workerTarget = new EventTarget();
  const registration = { update: vi.fn().mockResolvedValue(undefined) };
  const serviceWorker = Object.assign(workerTarget, {
    controller: initiallyControlled ? {} : null,
    ready: Promise.resolve(registration),
  }) as unknown as ServiceWorkerContainer;
  const location = { reload: vi.fn() };
  const environment: PwaRegistrationEnvironment = {
    clearInterval: vi.fn(),
    createUpdateChannel: channel === undefined ? undefined : () => channel,
    document: Object.assign(documentTarget, { hidden: false }),
    location,
    navigator: { onLine: true, serviceWorker },
    now: () => Date.now(),
    setInterval: vi.fn(() => 7 as unknown as ReturnType<typeof setInterval>),
    window: windowTarget,
  };
  let options: RegisterSWOptions | undefined;
  const activate = vi.fn().mockResolvedValue(undefined);
  const register = vi.fn((next: RegisterSWOptions) => {
    options = next;
    next.onRegisteredSW?.('/sw.js', registration as unknown as ServiceWorkerRegistration);
    return activate;
  });
  const adapter = createPwaRegistrationAdapter(register, environment);
  return { activate, adapter, location, options: () => options, register, workerTarget };
}

describe('PWA registration adapter (MMR-369)', () => {
  it('registers once across Strict Mode-style start/stop churn', () => {
    const { adapter, register } = fixture();
    adapter.start();
    adapter.stop();
    adapter.start();
    expect(register).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ immediate: true }));
  });

  it('suppresses generated reloads and activates through the controller', async () => {
    const { activate, adapter, location, options, workerTarget } = fixture();
    adapter.start();
    options()?.onNeedReload?.();
    expect(location.reload).not.toHaveBeenCalled();
    options()?.onNeedRefresh?.();
    await adapter.controller.refreshNow();
    expect(activate).toHaveBeenCalledWith(false);
    workerTarget.dispatchEvent(new Event('controllerchange'));
    expect(location.reload).toHaveBeenCalledOnce();
  });

  it('does not mistake first installation control for an update', () => {
    const { adapter, location, workerTarget } = fixture(false);
    adapter.start();
    workerTarget.dispatchEvent(new Event('controllerchange'));
    expect(adapter.controller.getSnapshot().phase).toBe('idle');
    expect(location.reload).not.toHaveBeenCalled();
  });

  it('recognizes a waiting update when the first page began uncontrolled', () => {
    const { adapter, options, workerTarget } = fixture(false);
    adapter.start();
    options()?.onNeedRefresh?.();
    workerTarget.dispatchEvent(new Event('controllerchange'));
    expect(adapter.controller.getSnapshot().phase).toBe('activated-elsewhere');
  });

  it('turns later cross-tab activation into an explicit local action', async () => {
    const { adapter, location, workerTarget } = fixture();
    adapter.start();
    workerTarget.dispatchEvent(new Event('controllerchange'));
    expect(adapter.controller.getSnapshot().phase).toBe('activated-elsewhere');
    expect(location.reload).not.toHaveBeenCalled();
    await adapter.controller.refreshNow();
    expect(location.reload).toHaveBeenCalledOnce();
  });

  it('receives activation from the requesting tab over the update channel', () => {
    const channel = new FakeChannel();
    const { adapter, location } = fixture(true, channel);
    adapter.start();
    channel.dispatchEvent(new MessageEvent('message', { data: 'activated' }));
    expect(adapter.controller.getSnapshot().phase).toBe('activated-elsewhere');
    expect(location.reload).not.toHaveBeenCalled();
  });
});
