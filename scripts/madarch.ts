#!/usr/bin/env bun
/**
 * The `madarch` command line: `bun scripts/madarch.ts new [--home <folder>]`,
 * reached as `madarch` after `bun link` in a checkout (the `bin` field in
 * `package.json`) and as the compiled release binary the release build makes
 * (`bun build --compile` on this file; scripts/build-binary.ts assembles it).
 * The parsing, the printing and the exit codes live in `src/product/cli.ts`;
 * this script is only the entry: 0 when the work is done, 2 when an argument
 * or the products home cannot be used, 1 when a step failed (git refused),
 * each naming what is wrong on standard error.
 *
 * The command graph is loaded with a dynamic import below, after this
 * file's own statements run. Inside a compiled binary that order is what
 * keeps one pinned import of the product-repository program quiet: the
 * pinned release carries a guard that runs its own command line when a
 * running program's entry point resolves to the pinned file itself, and Bun
 * hands a compiled binary's entry position to every bundled module alike —
 * without the shift the pinned program would answer the user's arguments
 * (and refuse them) before madarch sighted a single one. Pointing
 * `process.argv[1]` at the running executable first breaks that match; a
 * source checkout never matched it anyway, so the source runs keep their
 * argv as `bun scripts/madarch.ts …` laid it.
 */
process.argv[1] = process.execPath;

const { main } = await import('../src/product/cli.js');

process.exitCode = await main(process.argv.slice(2));
