/**
 * Teaches the compiler about the matchers the `*.dom.test.tsx` files use.
 *
 * The runtime side is in `test-setup.ts`, which imports
 * `@testing-library/jest-dom/vitest` when -- and only when -- a document exists.
 * That conditional import gives the matchers to Vitest's `Assertion` at run time
 * but contributes no types to the program, so the compiler reports every
 * `toHaveTextContent` as missing while the tests pass. The two halves have to be
 * declared in the same place or they drift, which is the failure mode that
 * leaves a red typecheck and a green suite.
 *
 * The `/vitest` entry specifically, not the package root: the root augments
 * Jest's globals, and this project has no Jest and does not enable Vitest
 * globals, so it would augment a type nothing is asserted against.
 */
/// <reference types="@testing-library/jest-dom/vitest" />
