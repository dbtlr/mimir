import { registerSW } from 'virtual:pwa-register';
import type { RegisterSWOptions } from 'virtual:pwa-register';

import { createPwaUpdateController } from './pwa-update';
import type { PwaUpdateController, PwaUpdateEffects } from './pwa-update';

type Register = (options: RegisterSWOptions) => (reloadPage?: boolean) => Promise<void>;

export type PwaRegistrationEnvironment = {
  clearInterval: (handle: ReturnType<typeof setInterval>) => void;
  document: Pick<Document, 'addEventListener' | 'hidden' | 'removeEventListener'>;
  location: Pick<Location, 'reload'>;
  navigator: Pick<Navigator, 'onLine'> & { serviceWorker?: ServiceWorkerContainer };
  now: () => number;
  setInterval: (listener: () => void, delay: number) => ReturnType<typeof setInterval>;
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
};

export type PwaRegistrationAdapter = {
  readonly controller: PwaUpdateController;
  start: () => void;
  stop: () => void;
};

const listen = (
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  event: string,
  listener: () => void,
): (() => void) => {
  target.addEventListener(event, listener);
  return () => target.removeEventListener(event, listener);
};

/** The one browser-facing adapter for virtual:pwa-register and service workers. */
export function createPwaRegistrationAdapter(
  register: Register,
  environment: PwaRegistrationEnvironment,
): PwaRegistrationAdapter {
  let activateWaiting: ((reloadPage?: boolean) => Promise<void>) | null = null;
  let registration: ServiceWorkerRegistration | undefined;
  let registered = false;
  let hadController = false;

  const serviceWorker = () => environment.navigator.serviceWorker;
  const effects: PwaUpdateEffects = {
    async activateWaiting() {
      if (activateWaiting === null) {
        throw new Error('Update service is not ready');
      }
      await activateWaiting(false);
    },
    async checkForUpdate() {
      const container = serviceWorker();
      if (container === undefined) {
        return;
      }
      const current = registration ?? (await container.ready);
      registration = current;
      await current.update();
    },
    clearInterval: environment.clearInterval,
    isVisible: () => !environment.document.hidden,
    listenControllerChange(listener) {
      const container = serviceWorker();
      if (container === undefined) {
        return () => {};
      }
      const onControllerChange = () => {
        // A first install taking control is not an update. Every later change
        // is origin-wide activation and must be acknowledged by this tab.
        if (!hadController) {
          hadController = true;
          return;
        }
        listener();
      };
      return listen(container, 'controllerchange', onControllerChange);
    },
    listenFocus: (listener) => listen(environment.window, 'focus', listener),
    listenOnline: (listener) => listen(environment.window, 'online', listener),
    listenVisibilityChange: (listener) =>
      listen(environment.document, 'visibilitychange', listener),
    now: environment.now,
    reload: () => environment.location.reload(),
    setInterval: environment.setInterval,
  };
  const controller = createPwaUpdateController(effects);

  return {
    controller,
    start() {
      const container = serviceWorker();
      if (!registered && container !== undefined) {
        registered = true;
        hadController = container.controller !== null;
        activateWaiting = register({
          immediate: true,
          // The generated helper otherwise reloads after controlling. The raw
          // controllerchange listener above routes that event through our
          // per-tab explicit-action guard instead.
          onNeedRefresh: () => controller.workerWaiting(),
          onNeedReload: () => {},
          onRegisterError: (error) => controller.failed(error),
          onRegisteredSW: (_url, nextRegistration) => {
            registration = nextRegistration;
          },
        });
      }
      controller.start();
    },
    stop: () => controller.stop(),
  };
}

const browserEnvironment: PwaRegistrationEnvironment = {
  clearInterval: (handle) => globalThis.clearInterval(handle),
  document: globalThis.document,
  location: globalThis.location,
  navigator: globalThis.navigator,
  now: () => Date.now(),
  setInterval: (listener, delay) => globalThis.setInterval(listener, delay),
  window: globalThis.window,
};

export const pwaRegistration = createPwaRegistrationAdapter(registerSW, browserEnvironment);
