/**
 * The closures a madarch release carries (decision 0035, item 4): the hashes
 * of the plugin folders that ship inside the binary, as the release build
 * computed them. A closure whose hash stands here runs without further
 * approval; any other waits for a person to approve its hash, and until then
 * runs only as validation (the conformance kit), publishing nothing.
 *
 * The list is code, not a file beside the binary: whatever build compiles this
 * module compiles the plugin folders it carries, and the hashes are computed from
 * those texts (`src/plugin/bundled.ts`), so a plugin folder swapped on disk never
 * changes what the binary trusts.
 */
import { bundledClosureHashes } from './bundled.js';

export const RELEASE_CLOSURE_HASHES: readonly string[] = bundledClosureHashes();
