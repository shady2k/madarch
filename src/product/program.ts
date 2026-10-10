/**
 * The pinned release of the shady2k-skills set's product-repository program
 * (decision 0019: the product repository's lifecycle is the set's; madarch
 * bundles one pinned release and is its thin wrapper — `madarch new` creates
 * the draft through it, and the manifest is read by the same reader the set
 * checks its own fixtures against). This module is the one import of it: the
 * vendored file's folder and the pinned version are named here, nowhere else,
 * and the types come from the declarations beside the vendored file.
 *
 * What the program knows is the layout, the manifest and git; it knows no
 * project and no wiki. What madarch adds around it — the products home's
 * default and `MADARCH_HOME`, the day from a given moment, the wiki — stays
 * in madarch's own modules.
 */
export {
  PRODUCT_SCHEMA_VERSION,
  MANIFEST_FILE,
  createDraft,
  readProduct,
} from '../../vendor/shady2k-skills/0.94.0/product.mjs';
export type {
  ProgramDraftResult,
  ProgramIdentity,
  ProgramRead,
  ProgramRepo,
  ProgramGitEnv,
} from '../../vendor/shady2k-skills/0.94.0/product.mjs';
