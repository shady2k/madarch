/**
 * Reading a product's identity back from its manifest
 * (docs/changes/draft-product/capabilities/product-repository.md,
 * requirement manifest). `workspace.yaml` is how madarch and an agent
 * recognise a product repository: its `schemaVersion`, `id` and `name` are
 * never renamed, and a field this madarch does not know is ignored, so a
 * manifest written by a later madarch still opens.
 *
 * The reader is the skill set's, at the release pinned in `./program.ts`
 * (decision 0019: the manifest's schema is the set's program; madarch keeps
 * this module as its own reading interface and reads through the pinned
 * release, so a folder the set made, a draft madarch made and a folder
 * written by hand read the same, refusals included). The consumer tests
 * (`test/product-manifest.test.ts`) hold this module to the set's own
 * fixture cases and example folder.
 */
import { readProduct as programReadProduct } from './program.js';
import type { ProgramIdentity, ProgramRead, ProgramRepo } from './program.js';

/** The manifest's file, at a product folder's root. */
export { MANIFEST_FILE } from './program.js';
import { MANIFEST_FILE } from './program.js';

/** One declared code repository of a product's manifest. */
export type ProductRepo = ProgramRepo;

/** A product folder, read: where it is, and the fields that never change. */
export type ProductIdentity = ProgramIdentity;

/** How reading a product folder ended; a refusal names the file and its line. */
export type ProductRead = ProgramRead;

/**
 * Reads one product folder's manifest. Refused — never defaulted, never
 * logged — when the folder holds no manifest, the manifest cannot be read,
 * is not the manifest's plain subset of YAML, names no `id`, names no
 * schema version this madarch knows, or carries a `skills` or `repos` field
 * that cannot be used. Every other field is ignored: the manifest grows by
 * fields added beside the three.
 */
export function readProduct(productFolder: string): ProductRead {
  return programReadProduct(productFolder);
}
