// jest-dom 7.0.1 augments `Assertion<T>`, but Vitest 5 declares
// `Assertion<R, T>`, so the merge fails and every jest-dom matcher on
// `.resolves` types as a non-Promise (testing-library/jest-dom#738). This is the
// upstream fix from testing-library/jest-dom#742. Delete this file and restore
// the '@testing-library/jest-dom/vitest' import in setup.ts once a release
// ships it.
// Module augmentation must stay an empty `interface` to merge with Vitest's.
// oxlint-disable typescript/consistent-type-definitions, typescript/no-empty-interface
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

declare module 'vitest' {
  interface Assertion<R, T> extends TestingLibraryMatchers<T, R> {}
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<unknown, unknown> {}
}
