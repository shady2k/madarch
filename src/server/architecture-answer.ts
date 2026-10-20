/**
 * The Architecture answer the wiki serves, built once per revision (madarch-tzte.23.8).
 *
 * `architectureBundle` (src/product-wiki/architecture.ts) is pure and takes seconds:
 * it renders every view of the merged model through a temporary query database, and it
 * scans every page's text for the ids each element's page names. A browser asks
 * `GET /api/architecture` on every page load — the shell's count and a page's element
 * links read it — so the answer is built for the product as it stands and handed out
 * until the product moves: measured on the current madarch tree, the first ask of a
 * revision cost **2 822–3 454 ms** and the asks after it **4–83 ms**.
 *
 * **What the answer depends on is what it is keyed by.** One walk of the product
 * (`ProductWiki.pageTexts`) gives both halves: the revision, and the served texts the
 * backlinks are read from. The revision digests every page's path and Markdown, the model's
 * source bytes, the stages' inputs and the product's manifest (`stagesSourceDigest`) — a
 * declared repository is a note in the answer, so the manifest is one of its dependencies —
 * and the registry's bytes. A saved page, a saved model file or an edited manifest is a new
 * key and a new build; nothing else is, and the working tree is not watched. The identity the
 * answer reads is the manifest's own, read at every build: the wiki opens the product once and
 * keeps the repositories it read then, so a repository declared since would otherwise never
 * reach the answer.
 *
 * **One build at a time.** Two readers of one revision share the build the first asked
 * for, so a page load that opens two tabs pays for the render once. A build that fails is
 * not kept: the next ask tries again, and the failure is the route's own to answer.
 */
import { readProduct, type ProductIdentity } from '../product/manifest.js';
import { readProductModel } from '../product-wiki/model.js';
import { architectureBundle, type ArchitectureBundle } from '../product-wiki/architecture.js';
import type { ProductWiki } from '../product-wiki/pages.js';

/** The Architecture answer over one open product: the bundle of the revision it stands at. */
export interface ArchitectureAnswer {
  /** The bundle of the product as it stands now: the kept one when nothing moved, else a fresh build. */
  answer(): Promise<ArchitectureBundle>;
}

/**
 * The product's identity as the manifest holds it now. The wiki opens the product once and
 * keeps the repositories it read then; the answer names a declared repository that is not
 * checked out, so it reads that list from the manifest again — the same bytes its key
 * hashes — rather than from the copy the process opened with.
 */
function identityNow(wiki: ProductWiki): Pick<ProductIdentity, 'folder' | 'repos'> {
  const read = readProduct(wiki.product.folder);
  return read.ok ? read.product : wiki.product;
}

/**
 * One build of the answer from the product as it stands. A product whose model does not
 * compile needs no page text: the answer is the errors, and the backlinks over every page
 * are work nothing would read.
 */
async function build(wiki: ProductWiki, texts: ReadonlyMap<string, string>): Promise<ArchitectureBundle> {
  const product = readProductModel(identityNow(wiki));
  if (product.model === undefined) {
    return { notes: product.notes, errors: product.errors, warnings: product.warnings, sources: product.sources };
  }
  return await architectureBundle(product.model, product.notes, product.warnings, product.sources, texts);
}

/** The cache one server holds: the bundle of the revision it last built, and the build in flight. */
export function createArchitectureAnswer(wiki: ProductWiki): ArchitectureAnswer {
  let kept: { readonly key: string; readonly bundle: ArchitectureBundle } | undefined;
  let building: { readonly key: string; readonly built: Promise<ArchitectureBundle> } | undefined;
  return {
    async answer(): Promise<ArchitectureBundle> {
      // One walk gives the revision the answer is keyed by and the texts it scans; a second
      // walk per ask would cost what the answer costs to build on a large product.
      const read = wiki.pageTexts();
      const key = read.ok ? read.revision : undefined;
      if (key !== undefined && kept !== undefined && kept.key === key) return kept.bundle;
      if (key !== undefined && building !== undefined && building.key === key) return await building.built;
      const built = build(wiki, read.ok ? read.texts : new Map());
      // A product whose pages cannot be read now has no key to keep an answer under: the answer
      // is built for this ask and the next ask reads the pages again.
      if (key === undefined) return await built;
      const started = { key, built };
      building = started;
      try {
        const bundle = await built;
        kept = { key, bundle };
        return bundle;
      } finally {
        if (building === started) building = undefined;
      }
    },
  };
}
