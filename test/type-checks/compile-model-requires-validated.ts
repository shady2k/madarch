/**
 * Not a test suite: a compile-time check for S9 ("`compileModel` must not
 * be callable on an unvalidated model"). `bun run check` (`tsc --noEmit`)
 * fails if the `@ts-expect-error` below stops being an error — i.e. if
 * `compileModel` ever accepts a plain `IntendedModel` again — and also
 * fails if it were wrong for some other reason, since `@ts-expect-error`
 * only suppresses exactly one diagnostic on its line. This file is not
 * named `*.test.ts`, so `bun test` never runs it; only `tsc` reads it.
 */
import { compileModel, type IntendedModel, type ValidatedModel } from '../../src/index.js';

const intended: IntendedModel = {
  version: 1,
  elements: [],
  interfaces: [],
  relations: [],
  categories: [],
  zones: [],
  environments: [],
  states: [],
};

// @ts-expect-error — an IntendedModel is not a ValidatedModel: only loadModel/parseModel produce one.
compileModel(intended);

declare const validated: ValidatedModel;
compileModel(validated); // this one must type-check with no error.
