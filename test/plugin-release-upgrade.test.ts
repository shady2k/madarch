/**
 * A product seeded by the release before this one keeps its lock valid after the upgrade (ALX-1937, ALX-2067 finding 2).
 *
 * The disk plugin's `product.uses-repository` exception left the plugin in this release, so the folder a product holds
 * hashes differently from the one the release carries. A person who initialised the product with the previous release
 * never edited those bytes, so refusing them as `needs-approval` would demand an approval of a closure madarch itself
 * shipped: the release trusts the closure it supersedes, by its exact hash, and nothing else.
 *
 * The test rebuilds the previous folder from the one this release carries — the only change is the removed exception —
 * and holds that closure to the recorded hash. A change to the plugin's other files moves that hash, and the recorded
 * superseded closure has to be recomputed with this test in the same change.
 */
import { afterAll, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closureOf } from '../src/plugin/closure.js';
import { bundledClosureHashes } from '../src/plugin/bundled.js';
import { closureTrustProblem, isReleaseClosure } from '../src/plugin/snapshot.js';
import { RELEASE_CLOSURE_HASHES, SUPERSEDED_CLOSURE_HASHES } from '../src/plugin/release-closures.js';

const repository = fileURLToPath(new URL('..', import.meta.url));
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

/** The disk plugin's main.ts as the previous release carried it: the `product.uses-repository` condition it had. */
function previousDiskMain(current: string): string {
  const now = [
    '    // The product that pinned this repository refers to it (0039, item 1): the host names the product\'s own vertex, and',
    '    // the edge carries the same inventory evidence as the vertex it ends at. A product with no home kind is named here',
    '    // by nothing. Every pinned repository a turn reads is one the product\'s manifest linked, so the edge is stated for',
    '    // each of them and the product\'s own checkout never reaches this plugin (ALX-1937).',
    '    if (inputs.product !== undefined) edges.push(',
  ].join('\n');
  const then = [
    '    // The product that pinned this repository refers to it (0039, item 1): the host names the product\'s own vertex, and',
    '    // the edge carries the same inventory evidence as the vertex it ends at. A product with no home kind is named here',
    '    // by nothing, and the product\'s own checkout is no repository it uses, so neither states an edge.',
    '    if (inputs.product !== undefined && pin.repository !== inputs.productRepository) edges.push(',
  ].join('\n');
  // The plugin's input type named the product's own repository too; the release that carried the exception described its
  // input with that field, and the field left with the exception.
  const typedNow = "product?: { kind: string; key: Record<string, string | number | boolean> } };";
  const typedThen = "product?: { kind: string; key: Record<string, string | number | boolean> }; productRepository?: string };";
  if (!current.includes(now) || !current.includes(typedNow)) throw new Error(`${join(repository, 'plugins/disk/main.ts')}:1: this test rebuilds the previous disk plugin from the two edits this release carries, and the file no longer holds them`);
  return current.replace(now, then).replace(typedNow, typedThen);
}

test('the closure of the release before this one is trusted by its exact hash, and only its own bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-release-upgrade-'));
  roots.push(root);
  const folder = join(root, 'plugins/disk');
  cpSync(join(repository, 'plugins/disk'), folder, { recursive: true });
  writeFileSync(join(folder, 'main.ts'), previousDiskMain(readFileSync(join(folder, 'main.ts'), 'utf8')));
  const previous = closureOf(folder);
  // The recorded superseded closure is this folder's own hash: a product seeded by the previous release holds exactly
  // these bytes, and an edit of any other file of the plugin moves the hash and has to move this record with it.
  expect(previous.hash).toBe(SUPERSEDED_CLOSURE_HASHES[0]!);
  expect(isReleaseClosure(previous.hash)).toBe(true);
  expect(isReleaseClosure(previous.hash, bundledClosureHashes())).toBe(false);
  // A closure the release carries runs without approval; one byte changed in it does not.
  const changed = join(root, 'changed');
  cpSync(folder, changed, { recursive: true });
  writeFileSync(join(changed, 'main.ts'), `${readFileSync(join(changed, 'main.ts'), 'utf8')}\n// an edit in the product\n`);
  const edited = closureOf(changed);
  expect(isReleaseClosure(edited.hash)).toBe(false);
  const refusal = closureTrustProblem(edited, 'production', join(changed, 'plugin.json'));
  expect(refusal?.code).toBe('needs-approval');
  // The trust list is the release's closures and the superseded ones, never a wider rule.
  expect(RELEASE_CLOSURE_HASHES).toEqual([...bundledClosureHashes(), ...SUPERSEDED_CLOSURE_HASHES]);
});
