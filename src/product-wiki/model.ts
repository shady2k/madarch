/**
 * The product's architecture model, read for the wiki (feature E,
 * madarch-iuc.15): the product's own model in the product repository's
 * `model/` folder (the same `*.yaml` files the loader reads from
 * `madarch/`, at the folder the product program lays out) merged with each
 * declared code repository's own `madarch/` model under `repos/`.
 *
 * The merge rule: the product's model is the spine — its own files first,
 * in file-name order, then each repository's files in the manifest's
 * repository order, each repository's files in file-name order. The loader
 * (`parseModel`) already concatenates sections across files and refuses
 * duplicate ids, so a product element and a repository element with one id
 * is a named compile error, never a silent override; a repository file may
 * refine what the product declared (a `refines` relation, a child
 * element), which is the set's own refinement rule. The model is read
 * fresh on every ask — the same live rule the wiki's pages follow.
 *
 * Two kinds of problem, never a silent smaller result:
 * - `errors` — the model does not compile; each names file, line and path.
 * - `notes` — the wiki still shows a model, but from less than the whole
 *   input: a declared repository with no checkout, a model file that could
 *   not be read. Each names what is missing, at its place.
 *
 * Determinism: a merged model renders at the fixed moment
 * (`NO_REPO_TIME`), never the clock.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProductIdentity } from '../product/manifest.js';

/** The product's own model folder, at the product repository's root. */
const PRODUCT_MODEL_FOLDER = 'model';

/** The folder of a code repository's own model, within the repository. */
const REPO_MODEL_FOLDER = 'madarch';




/**
 * The raw bytes of every model source, digested: the freshness key the
 * wiki's revision rides (feature E) — a saved model file changes the
 * digest, so the wiki's stream reports a change and the section is asked
 * again, exactly like a saved document. The bytes only: no parse, no
 * compile — this runs at every pages ask.
 */
export function modelSourceDigest(product: Pick<ProductIdentity, 'folder' | 'repos'>): string {
  const hash = createHash('sha256');
  const digestFolder = (prefix: string, folder: string): void => {
    for (const name of yamlFiles(folder)) {
      const path = prefix + name;
      try {
        hash.update(`${path}\u0000`);
        hash.update(readFileSync(join(folder, name)));
        hash.update('\u0000');
      } catch {
        hash.update(`${path}\u0000unreadable\u0000`);
      }
    }
  };
  digestFolder(`${PRODUCT_MODEL_FOLDER}/`, join(product.folder, PRODUCT_MODEL_FOLDER));
  for (const repo of product.repos) {
    digestFolder(`repos/${repo.name}/${REPO_MODEL_FOLDER}/`, join(product.folder, 'repos', repo.name, REPO_MODEL_FOLDER));
  }
  return hash.digest('hex');
}

/** Lists a folder's `*.yaml` files in name order; `[]` when the folder is absent. */
function yamlFiles(folder: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(folder);
  } catch {
    return [];
  }
  return entries.filter((name) => name.endsWith('.yaml')).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
