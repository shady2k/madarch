#!/usr/bin/env bun
/**
 * The `madarch` command line: `bun scripts/madarch.ts new [--home <folder>]`,
 * reached as `madarch` after `bun link` in a checkout (the `bin` field in
 * `package.json`). The parsing, the printing and the exit codes live in
 * `src/product/cli.ts`; this script is only the entry: 0 when the draft
 * was created, 2 when an argument or the products home cannot be used, 1
 * when a step of the creation failed (git refused), each naming what is
 * wrong on standard error.
 */
import { main } from '../src/product/cli.js';

process.exitCode = main(process.argv.slice(2));
