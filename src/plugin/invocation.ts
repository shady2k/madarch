/**
 * The words a sandbox starts the runtime with for one plugin entry (decision 0035, item 7): madarch's own plugins are
 * TypeScript and run on the Bun inside madarch's binary. A compiled madarch binary has no separate interpreter to
 * start, so it starts itself with `--plugin-entry` and runs the entry; a `bun` runtime takes the entry as the script
 * it runs. Neither needs an interpreter of its own.
 */
import { basename } from 'node:path';

/** The runtime's words: the marker and the entry path for a compiled binary, the entry alone for a `bun` runtime. */
export function pluginInvocation(runtime: string, entryPath: string): string[] {
  const compiled = basename(runtime) !== 'bun' && basename(runtime) !== 'bun.exe';
  return compiled ? ['--plugin-entry', entryPath] : [entryPath];
}
