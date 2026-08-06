export const UPDATE_CHECK_THROTTLE_MS = 60_000;
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60_000;

export type PwaUpdatePhase = 'idle' | 'waiting' | 'activated-elsewhere' | 'applying' | 'error';

export type PwaUpdateSnapshot = {
  readonly available: boolean;
  readonly checking: boolean;
  readonly error: string | null;
  readonly message: string | null;
  readonly phase: PwaUpdatePhase;
};

export type PwaUpdateEffects = {
  activateWaiting: () => Promise<void>;
  checkForUpdate: () => Promise<void>;
  clearInterval: (handle: ReturnType<typeof setInterval>) => void;
  isVisible: () => boolean;
  listenControllerChange: (listener: () => void) => () => void;
  listenFocus: (listener: () => void) => () => void;
  listenOnline: (listener: () => void) => () => void;
  listenVisibilityChange: (listener: () => void) => () => void;
  now: () => number;
  reload: () => void;
  setInterval: (listener: () => void, delay: number) => ReturnType<typeof setInterval>;
};

export type PwaUpdateController = {
  checkForUpdate: () => Promise<void>;
  controllerChanged: () => void;
  failed: (error: unknown) => void;
  getSnapshot: () => PwaUpdateSnapshot;
  refreshNow: () => Promise<void>;
  start: () => void;
  stop: () => void;
  subscribe: (listener: () => void) => () => void;
  workerWaiting: (isUpdate?: boolean) => void;
};

const IDLE: PwaUpdateSnapshot = Object.freeze({
  available: false,
  checking: false,
  error: null,
  message: null,
  phase: 'idle',
});

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

/**
 * Operator-controlled PWA update state. Browser registration and React are
 * deliberately injected so a reload can only follow this tab's explicit
 * refresh action, even when another tab activates the worker origin-wide.
 */
export function createPwaUpdateController(effects: PwaUpdateEffects): PwaUpdateController {
  let snapshot = IDLE;
  let knownUpdate: 'waiting' | 'activated' | null = null;
  let started = false;
  let applying = false;
  let reloaded = false;
  let checking: Promise<void> | null = null;
  let backgroundChecking: Promise<void> | null = null;
  let lastBackgroundCheck = Number.NEGATIVE_INFINITY;
  let interval: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<() => void>();
  let cleanups: (() => void)[] = [];

  const publish = (next: PwaUpdateSnapshot) => {
    if (
      snapshot.available === next.available &&
      snapshot.checking === next.checking &&
      snapshot.error === next.error &&
      snapshot.message === next.message &&
      snapshot.phase === next.phase
    ) {
      return;
    }
    snapshot = Object.freeze(next);
    for (const listener of listeners) {
      listener();
    }
  };

  const phaseSnapshot = (
    phase: PwaUpdatePhase,
    options?: { checking?: boolean; error?: string | null },
  ): PwaUpdateSnapshot => {
    const messages: Record<PwaUpdatePhase, string | null> = {
      'activated-elsewhere': 'Update installed — refresh this tab when ready',
      applying: 'Refreshing…',
      error: 'Update failed — retry when ready',
      idle: null,
      waiting: "Update ready — refresh when you're done",
    };
    return {
      available: knownUpdate !== null,
      checking: options?.checking ?? false,
      error: options?.error ?? null,
      message: messages[phase],
      phase,
    };
  };

  const restingPhase = (): 'idle' | 'waiting' | 'activated-elsewhere' => {
    if (knownUpdate === 'waiting') {
      return 'waiting';
    }
    return knownUpdate === 'activated' ? 'activated-elsewhere' : 'idle';
  };

  const backgroundCheck = async () => {
    const now = effects.now();
    if (
      !effects.isVisible() ||
      checking !== null ||
      backgroundChecking !== null ||
      now - lastBackgroundCheck < UPDATE_CHECK_THROTTLE_MS
    ) {
      return;
    }
    const runCheck = async () => {
      try {
        await effects.checkForUpdate();
        lastBackgroundCheck = effects.now();
      } catch {
        // Discovery is fail-soft. An operator-requested check reports errors.
      } finally {
        backgroundChecking = null;
      }
    };
    backgroundChecking = runCheck();
    await backgroundChecking;
  };

  const controller: PwaUpdateController = {
    async checkForUpdate() {
      if (checking !== null || applying) {
        return checking ?? Promise.resolve();
      }
      publish(phaseSnapshot(restingPhase(), { checking: true }));
      const runCheck = async () => {
        try {
          await effects.checkForUpdate();
          publish(phaseSnapshot(restingPhase()));
        } catch (error) {
          publish(
            phaseSnapshot('error', {
              error: errorMessage(error, 'Could not check for an update'),
            }),
          );
        } finally {
          checking = null;
        }
      };
      checking = runCheck();
      return checking;
    },

    controllerChanged() {
      if (applying) {
        if (!reloaded) {
          reloaded = true;
          effects.reload();
        }
        return;
      }
      knownUpdate = 'activated';
      publish(phaseSnapshot('activated-elsewhere'));
    },

    failed(error) {
      if (applying) {
        applying = false;
      }
      publish(
        phaseSnapshot('error', {
          error: errorMessage(error, 'Could not register the console update service'),
        }),
      );
    },

    getSnapshot: () => snapshot,

    async refreshNow() {
      if (applying) {
        return;
      }
      applying = true;
      publish(phaseSnapshot('applying'));
      if (knownUpdate !== 'waiting') {
        if (!reloaded) {
          reloaded = true;
          effects.reload();
        }
        return;
      }
      try {
        await effects.activateWaiting();
        // controllerchange owns reload so the new worker is controlling first.
      } catch (error) {
        applying = false;
        publish(
          phaseSnapshot('error', {
            error: errorMessage(error, 'Could not activate the update'),
          }),
        );
      }
    },

    start() {
      if (started) {
        return;
      }
      started = true;
      const check = () => void backgroundCheck();
      cleanups = [
        effects.listenFocus(check),
        effects.listenOnline(check),
        effects.listenVisibilityChange(check),
        effects.listenControllerChange(() => controller.controllerChanged()),
      ];
      interval = effects.setInterval(check, UPDATE_CHECK_INTERVAL_MS);
    },

    stop() {
      if (!started) {
        return;
      }
      started = false;
      for (const cleanup of cleanups) {
        cleanup();
      }
      cleanups = [];
      if (interval !== null) {
        effects.clearInterval(interval);
      }
      interval = null;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    workerWaiting(isUpdate = true) {
      if (!isUpdate || knownUpdate === 'activated' || applying) {
        return;
      }
      knownUpdate = 'waiting';
      publish(phaseSnapshot('waiting'));
    },
  };

  return controller;
}
