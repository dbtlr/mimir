import { describe, expect, it, vi } from 'vitest';

import {
  createPwaUpdateController,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CHECK_THROTTLE_MS,
} from '../lib/pwa-update';
import type { PwaUpdateEffects } from '../lib/pwa-update';

function fixture() {
  let now = 10_000;
  let visible = true;
  const eventListeners = new Map<string, Set<() => void>>();
  const listen = (event: string) => (listener: () => void) => {
    const listeners = eventListeners.get(event) ?? new Set();
    listeners.add(listener);
    eventListeners.set(event, listeners);
    return () => listeners.delete(listener);
  };
  const effects: PwaUpdateEffects = {
    activateWaiting: vi.fn().mockResolvedValue(undefined),
    checkForUpdate: vi.fn().mockResolvedValue(undefined),
    clearInterval: vi.fn(),
    isVisible: () => visible,
    listenControllerChange: listen('controllerchange'),
    listenFocus: listen('focus'),
    listenOnline: listen('online'),
    listenVisibilityChange: listen('visibilitychange'),
    now: () => now,
    reload: vi.fn(),
    setInterval: vi.fn(() => 42 as unknown as ReturnType<typeof setInterval>),
  };
  const controller = createPwaUpdateController(effects);
  return {
    controller,
    effects,
    emit: (event: string) => {
      for (const listener of eventListeners.get(event) ?? []) {
        listener();
      }
    },
    setNow: (value: number) => {
      now = value;
    },
    setVisible: (value: boolean) => {
      visible = value;
    },
  };
}

describe('PWA update controller (MMR-369)', () => {
  it('distinguishes first installation from a waiting update', () => {
    const { controller } = fixture();
    controller.workerWaiting(false);
    expect(controller.getSnapshot().phase).toBe('idle');
    controller.workerWaiting();
    expect(controller.getSnapshot()).toMatchObject({ available: true, phase: 'waiting' });
  });

  it('activates once and reloads only after controller change', async () => {
    const { controller, effects } = fixture();
    controller.workerWaiting();
    await controller.refreshNow();
    await controller.refreshNow();
    expect(effects.activateWaiting).toHaveBeenCalledOnce();
    expect(effects.reload).not.toHaveBeenCalled();
    controller.controllerChanged();
    controller.controllerChanged();
    expect(effects.reload).toHaveBeenCalledOnce();
  });

  it('does not reload when another tab activates', async () => {
    const { controller, effects } = fixture();
    controller.workerWaiting();
    controller.controllerChanged();
    expect(controller.getSnapshot().phase).toBe('activated-elsewhere');
    expect(effects.reload).not.toHaveBeenCalled();
    await controller.refreshNow();
    expect(effects.activateWaiting).not.toHaveBeenCalled();
    expect(effects.reload).toHaveBeenCalledOnce();
  });

  it('preserves an actionable state when activation fails', async () => {
    const { controller, effects } = fixture();
    vi.mocked(effects.activateWaiting).mockRejectedValueOnce(new Error('activation refused'));
    controller.workerWaiting();
    await controller.refreshNow();
    expect(controller.getSnapshot()).toMatchObject({
      available: true,
      error: 'activation refused',
      phase: 'error',
    });
    await controller.refreshNow();
    expect(effects.activateWaiting).toHaveBeenCalledTimes(2);
  });

  it('reports explicit check errors but leaves background failures fail-soft', async () => {
    const explicit = fixture();
    vi.mocked(explicit.effects.checkForUpdate).mockRejectedValueOnce(new Error('network down'));
    await explicit.controller.checkForUpdate();
    expect(explicit.controller.getSnapshot()).toMatchObject({
      error: 'network down',
      phase: 'error',
    });

    const background = fixture();
    vi.mocked(background.effects.checkForUpdate).mockRejectedValueOnce(new Error('network down'));
    background.controller.start();
    background.emit('focus');
    await vi.waitFor(() => expect(background.effects.checkForUpdate).toHaveBeenCalledOnce());
    expect(background.controller.getSnapshot().phase).toBe('idle');
  });

  it('throttles visible lifecycle checks and skips hidden intervals', async () => {
    const { controller, effects, emit, setNow, setVisible } = fixture();
    controller.start();
    expect(effects.setInterval).toHaveBeenCalledWith(
      expect.any(Function),
      UPDATE_CHECK_INTERVAL_MS,
    );
    emit('focus');
    emit('online');
    await vi.waitFor(() => expect(effects.checkForUpdate).toHaveBeenCalledOnce());
    setNow(10_000 + UPDATE_CHECK_THROTTLE_MS);
    setVisible(false);
    emit('visibilitychange');
    expect(effects.checkForUpdate).toHaveBeenCalledOnce();
    setVisible(true);
    emit('visibilitychange');
    await vi.waitFor(() => expect(effects.checkForUpdate).toHaveBeenCalledTimes(2));
  });

  it('starts idempotently and removes every listener on stop', () => {
    const { controller, effects, emit } = fixture();
    controller.start();
    controller.start();
    expect(effects.setInterval).toHaveBeenCalledOnce();
    controller.stop();
    expect(effects.clearInterval).toHaveBeenCalledOnce();
    emit('controllerchange');
    expect(effects.reload).not.toHaveBeenCalled();
    expect(controller.getSnapshot().phase).toBe('idle');
  });
});
