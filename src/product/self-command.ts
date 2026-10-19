/**
 * How madarch names its own program for a subcommand of its own (`madarch
 * daemon-serve`, the unit's MCP server `madarch mcp-unit`): a command and its
 * arguments a child process is started with.
 *
 * Run from a checkout, that is `bun` and this repository's `scripts/madarch.ts`.
 * Run from a compiled binary, it is the binary itself, started again with the
 * same words: the bundle holds the command, and a `bun` has no file to read — the
 * release's own words were `error: Module not found "/scripts/madarch.ts"` on
 * Linux and macOS and `error: Module not found "B:\\scripts\\madarch.ts"` on Windows
 * (runs 39134773495 and 39135836826).
 *
 * Three measured facts say "this is a bundle", and any one is enough: the
 * embedded files the release carries (an empty list in every source and test
 * run, measured 2026-10-18), the bundle marker in this module's own URL, and a
 * derived script path answering no file. `Bun.main` is deliberately *not* one of
 * them: in `bun test` it is not this program's module — measured on the pod as
 * the test file, and in CI run 39137149685, where trusting it started
 * `bun daemon-serve …` inside a shard and the daemon never came up. A program that
 * is none of the three — a checkout whose script is gone — still starts itself,
 * since that is the only command line left that can answer.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The bundle marker in a compiled binary's own paths: `$bunfs` on Linux and macOS, `~BUN` on Windows. */
const BUNDLE_MARKER = /[/\\](?:\$bunfs|~BUN)[/\\]/;

/** What the caller may say about this program, for a test that cannot build a release binary. */
export interface SelfCommandReadings {
  /** The checkout's entry script; this repository's `scripts/madarch.ts` when it is left out. */
  readonly scriptPath?: string;
  /** Whether a path is a file; `node:fs`'s own `existsSync` when it is left out. */
  readonly scriptExists?: (path: string) => boolean;
  /** This module's own URL, the one a bundle marks; `import.meta.url` when it is left out. */
  readonly moduleUrl?: string;
  /** What this program carries inside itself; `Bun.embeddedFiles` when it is left out. */
  readonly embeddedFiles?: readonly unknown[];
}

/** Whether this program is a compiled binary rather than a source checkout. */
export function runsFromBundle(readings: SelfCommandReadings = {}): boolean {
  const scriptPath = readings.scriptPath ?? fileURLToPath(new URL('../../scripts/madarch.ts', import.meta.url));
  const scriptExists = readings.scriptExists ?? existsSync;
  const moduleUrl = readings.moduleUrl ?? import.meta.url;
  const embedded = readings.embeddedFiles ?? (Bun as unknown as { embeddedFiles?: readonly unknown[] }).embeddedFiles ?? [];
  return embedded.length > 0 || BUNDLE_MARKER.test(moduleUrl) || !scriptExists(scriptPath);
}

/** The command and arguments that start this build of madarch with the given words. */
export function selfCommand(words: readonly string[], readings: SelfCommandReadings = {}): { command: string; args: string[] } {
  if (runsFromBundle(readings)) return { command: process.execPath, args: [...words] };
  const scriptPath = readings.scriptPath ?? fileURLToPath(new URL('../../scripts/madarch.ts', import.meta.url));
  return { command: 'bun', args: [scriptPath, ...words] };
}
