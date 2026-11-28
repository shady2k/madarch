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

/**
 * The closures of the release immediately before this one that this release replaces, and still trusts.
 *
 * A product seeded by that release holds the plugin's source and `madarch/plugins.lock` as they were; its folder hashes
 * to exactly one of these closures, and running it needs no person's approval (decision 0035, item 4). Without this,
 * the first fill after an upgrade would refuse a product whose plugin sources nobody touched as `needs-approval`, and
 * the person would have to approve bytes that a madarch release already shipped. An entry is the closure's own hash,
 * never a class of closures: a folder edited in the product, or an upstream update the product has not merged, is still
 * untrusted and still needs approval.
 *
 * An entry leaves the list when the release that carried that closure is older than the previous one: a release trusts
 * its own closures and the ones it supersedes, and a product that skipped two releases merges upstream as decision 0035,
 * item 3, describes.
 */
export const SUPERSEDED_CLOSURE_HASHES: readonly string[] = [
  // The disk plugin 1.0.0 before ALX-1937 dropped its `product.uses-repository` exception, as this build hashes that
  // exact folder (`test/plugin-release-upgrade.test.ts` rebuilds it from the folder this release carries).
  '65aa5d166a15b6db3ea9bbf8cddf3318b48d05d86a71af77eeda0c355327ad1d',
];

/** Every closure this release trusts: its own, and the closures of the release it supersedes. */
export const RELEASE_CLOSURE_HASHES: readonly string[] = [...bundledClosureHashes(), ...SUPERSEDED_CLOSURE_HASHES];
