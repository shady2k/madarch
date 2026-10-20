/**
 * The Architecture answer the wiki serves, built once per revision (madarch-tzte.23.8).
 *
 * `architectureBundle` (src/product-wiki/architecture.ts) is pure and takes seconds:
 * it renders every view of the merged model through a temporary query database, and it
 * scans every page's text for the ids each element's page names. A browser asks
 * `GET /api/architecture` on every page load — the shell's count and a page's element
 * links read it — so the answer is built for the product as it stands and handed out
 * until the product moves: measured on the current madarch tree, one ask cost
 * 2 798–5 810 ms and the second ask of the same tree costs 0–1 ms.
 *
 * **What the answer depends on is what it is keyed by.** The wiki's revision
 * (`ProductWiki.pages`) digests every page's path and Markdown, the model's source
 * bytes and the stages' and registry's inputs; the manifest's own bytes are added
 * here, because a declared repository with no checkout is a note in the answer while
 * its model files are none. A saved page, a saved model file or an edited manifest is
 * a new key and a new build; nothing else is, and the working tree is not watched.
 *
 * **One build at a time.** Two readers of one revision share the build the first
 * asked for, so a page load that opens two tabs pays for the render once. A build
 * that fails is not kept: the next ask tries again, and the failure is the route's
 * own to answer.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MANIFEST_FILE } from '../product/manifest.js';
import { readProductModel } from '../product-wiki/model.js';
import { architectureBundle, type ArchitectureBundle } from '../product-wiki/architecture.js';
import type { ProductWiki } from '../product-wiki/pages.js';

/** The Architecture answer over one open product: the bundle of the revision it stands at. */
export interface ArchitectureAnswer {
  /** The bundle of the product as it stands now: the kept one when nothing moved, else a fresh build. */
  answer(): Promise<ArchitectureBundle>;
}

/** The manifest's bytes as a key part: a repository the manifest declares is part of what the answer says. */
function manifestKey(folder: string): string {
  try {
    return createHash('sha256').update(readFileSync(join(folder, MANIFEST_FILE))).digest('hex');
  } catch {
    // A wiki whose manifest cannot be read has no declared repository to name; the
    // marker keeps that state distinct from any readable manifest's digest.
    return 'unreadable';
  }
}

/** The key of the answer for the product as it stands, or undefined when its pages cannot be read at all. */
function keyOf(wiki: ProductWiki): string | undefined {
  const listed = wiki.pages();
  if (!listed.ok) return undefined;
  return `${listed.revision}\u0000${manifestKey(wiki.product.folder)}`;
}

/**
 * One build of the answer from the product as it stands. A product whose model does
 * not compile needs no page text: the answer is the errors, and the backlinks over
 * every page are work nothing would read. A product whose model compiles reads its
 * pages in one walk (`nextStepPages`): asking the wiki for each page on its own costs
 * one walk per page, which is minutes on a product of a thousand pages.
 */
async function build(wiki: ProductWiki): Promise<ArchitectureBundle> {
  const product = readProductModel(wiki.product);
  if (product.model === undefined) {
    return { notes: product.notes, errors: product.errors, warnings: product.warnings, sources: product.sources };
  }
  const listed = wiki.nextStepPages();
  const pages = new Map<string, string>();
  if (listed.ok) {
    for (const page of listed.pages) {
      if (page.markdown !== undefined) pages.set(page.path, page.markdown);
    }
  }
  return await architectureBundle(product.model, product.notes, product.warnings, product.sources, pages);
}

/** The cache one server holds: the bundle of the revision it last built, and the build in flight. */
export function createArchitectureAnswer(wiki: ProductWiki): ArchitectureAnswer {
  let kept: { readonly key: string; readonly bundle: ArchitectureBundle } | undefined;
  let building: { readonly key: string; readonly built: Promise<ArchitectureBundle> } | undefined;
  return {
    async answer(): Promise<ArchitectureBundle> {
      const key = keyOf(wiki);
      if (key !== undefined && kept !== undefined && kept.key === key) return kept.bundle;
      if (key !== undefined && building !== undefined && building.key === key) return await building.built;
      const built = build(wiki);
      // A product whose pages cannot be read now has no key to keep an answer under:
      // the answer is built for this ask and the next ask reads the pages again.
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
