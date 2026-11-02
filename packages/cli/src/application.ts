/**
 * The Application module Loom's toolchain reads: `loom build` loads it before
 * bundling to find the skills folder `skills()` names. The source refuses every
 * ask, so loading the module touches no store, and the entry (`main.ts`) is
 * what runs the real one.
 */
import { createApp } from './app';

export const application = createApp({
  git: {
    originUrl: () => Promise.resolve(undefined),
    readConfig: () => Promise.resolve(undefined),
    writeConfig: () => Promise.resolve(false),
  },
  store: () => Promise.reject(new Error('The toolchain Application opens no store.')),
});
