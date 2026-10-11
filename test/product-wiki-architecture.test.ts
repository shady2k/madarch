/**
 * The wiki's Architecture section, server side (feature E, madarch-iuc.15):
 * the merged model (product `model/` + each declared repository's
 * `madarch/` under `repos/`), the bundle (views with their Mermaid sources
 * and tables, elements with their relations and the pages naming them),
 * and the server's two routes. Everything reads fresh; compile errors are
 * values inside the answer, each naming file, line and path.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { readProduct } from '../src/product/manifest.js';
import { openProductWiki } from '../src/product-wiki/pages.js';
import { readProductModel } from '../src/product-wiki/model.js';
import { architectureBundle, pagesNamingElement, textNamesElement } from '../src/product-wiki/architecture.js';
import { startServer, type StartedServer } from '../src/index.js';

let folder: string | undefined;
let server: StartedServer | undefined;

function product(): string {
  folder = mkdtempSync(join(tmpdir(), 'madarch-arch-'));
  writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: demo\nname: Demo\n');
  return folder;
}

function write(path: string, content: string): void {
  const full = join(folder!, path);
  mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true });
  writeFileSync(full, content);
}

function requireProduct(at: string): ReturnType<typeof readProduct> extends { ok: true; product: infer P } ? P : never {
  const read = readProduct(at);
  if (!read.ok) throw new Error(read.message);
  return read.product as never;
}

/** The opened product wiki of a folder, for the revision tests. */
function requireProduct2(at: string): import('../src/product-wiki/pages.js').ProductWiki {
  const opened = openProductWiki(at);
  if (!opened.ok) throw new Error(opened.message);
  return opened.wiki;
}

const DRILL_DOWN = `version: 1

elements:
  - id: shop
    kind: domain
    name: Shop
  - id: checkout-web
    kind: service
    name: Checkout web
    parent: shop
  - id: catalog-api
    kind: service
    name: Catalog API
    parent: shop

relations:
  - id: web-reads-catalog
    name: reads prices
    from: checkout-web
    to: catalog-api
`;

afterEach(() => {
  server?.stop();
  server = undefined;
  if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
  folder = undefined;
});

describe('the merged model', () => {
  test('the product model/ alone compiles', () => {
    product();
    write('model/system.yaml', DRILL_DOWN);
    const result = readProductModel(requireProduct(folder!));
    expect(result.errors).toEqual([]);
    expect(result.model?.elements.map((element) => element.id)).toEqual(['catalog-api', 'checkout-web', 'shop']);
  });

  test("a repository's madarch/ under repos/ merges with the product's own model/", () => {
    product();
    write('workspace.yaml', 'schemaVersion: 1\nid: demo\nname: Demo\nrepos:\n  - name: alpha\n    url: https://example.com/alpha.git\n');
    write('model/system.yaml', DRILL_DOWN);
    write('repos/alpha/madarch/service.yaml', `version: 1

elements:
  - id: payments
    kind: domain
    name: Payments

relations:
  - id: web-charges
    name: charges
    from: checkout-web
    to: payments
`);
    const result = readProductModel(requireProduct(folder!));
    expect(result.errors).toEqual([]);
    expect(result.model?.elements.map((element) => element.id)).toEqual(['catalog-api', 'checkout-web', 'payments', 'shop']);
  });

  test('an id declared twice across the merge is a compile error naming both files', () => {
    product();
    write('workspace.yaml', 'schemaVersion: 1\nid: demo\nname: Demo\nrepos:\n  - name: alpha\n    url: https://example.com/alpha.git\n');
    write('model/system.yaml', DRILL_DOWN);
    write('repos/alpha/madarch/dup.yaml', 'version: 1\n\nelements:\n  - id: shop\n    kind: domain\n    name: Shop again\n');
    const result = readProductModel(requireProduct(folder!));
    expect(result.model).toBeUndefined();
    expect(result.errors).toHaveLength(2);
    const files = result.errors.map((error) => error.file).sort();
    expect(files).toEqual(['model/system.yaml', 'repos/alpha/madarch/dup.yaml']);
    expect(result.errors.every((error) => error.message.includes('more than once'))).toBe(true);
  });

  test('a checked-out repository with no madarch/ contributes nothing and names no error', () => {
    product();
    write('model/system.yaml', DRILL_DOWN);
    mkdirSync(join(folder!, 'repos', 'plain'), { recursive: true });
    const result = readProductModel(requireProduct(folder!));
    expect(result.errors).toEqual([]);
    expect(result.model).toBeDefined();
  });

  test('no model anywhere is one named error, not a crash', () => {
    product();
    const result = readProductModel(requireProduct(folder!));
    expect(result.model).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toContain('no model');
  });
});

describe('the bundle', () => {
  function bundleOf(markdown: string) {
    product();
    write('model/system.yaml', DRILL_DOWN);
    write('docs/vision.md', markdown);
    const result = readProductModel(requireProduct(folder!));
    if (result.model === undefined) throw new Error(result.errors.map((e) => e.message).join('; '));
    const pages = new Map([['docs/vision.md', markdown]]);
    return architectureBundle(result.model, result.notes, result.warnings, result.sources, pages);
  }

  test('one view per element with children, the landscape first, with Mermaid source and table', () => {
    const bundle = bundleOf('# Vision\n\nNothing named.\n');
    const views = bundle.model?.views ?? [];
    expect(views[0]!.scope).toBe('');
    expect(views.map((view) => view.scope)).toContain('shop');
    const shop = views.find((view) => view.scope === 'shop')!;
    expect(shop.mermaid).toContain('flowchart LR');
    expect(shop.mermaid).toContain('checkout_web');
    expect(shop.opens).toEqual([]); // neither child has children of its own: no drill-down
    expect(shop.up).toBeUndefined();
    expect(shop.table.columns).toEqual(['#', 'From', 'To', 'Relations']);
  });

  test('the view table carries the arrows, the element page the relations both ways', () => {
    const bundle = bundleOf('# Vision\n\nNothing named.\n');
    const shop = bundle.model?.views.find((view) => view.scope === 'shop')!;
    expect(shop.table.rows.length).toBeGreaterThan(0);
    const web = bundle.model?.elements.find((element) => element.id === 'checkout-web')!;
    expect(web.outgoing).toHaveLength(1);
    expect(web.outgoing[0]!.other).toBe('catalog-api');
    expect(web.outgoing[0]!.name).toBe('reads prices');
    const catalog = bundle.model?.elements.find((element) => element.id === 'catalog-api')!;
    expect(catalog.incoming).toHaveLength(1);
  });

  test('a document naming an element by its id, word-bounded, names it; a word inside another word does not', () => {
    const bundle = bundleOf('# Vision\n\nThe shop serves `checkout-web` and xcheckout-webx stands apart; checkout-web again.\n');
    const web = bundle.model?.elements.find((element) => element.id === 'checkout-web')!;
    // First standalone mention wins; a code-span mention still names it (the reader copied the id there); a bound-to-letters one does not.
    expect(web.namedBy).toEqual(['docs/vision.md']);
  });

  test('a model that does not compile returns its errors, each with file, line and path', () => {
    product();
    write('model/bad.yaml', 'version: 1\n\nelements:\n  - id: web\n    kind: servic\n');
    const result = readProductModel(requireProduct(folder!));
    expect(result.model).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.file).toBe('model/bad.yaml');
    expect(result.errors[0]!.line).toBe(5);
    expect(result.errors[0]!.path).toContain('kind');
  });

  test('a declared repository with no checkout rides as a note beside the compiled model', () => {
    product();
    write('workspace.yaml', 'schemaVersion: 1\nid: demo\nname: Demo\nrepos:\n  - name: gone\n    url: https://example.com/gone.git\n');
    write('model/system.yaml', DRILL_DOWN);
    const result = readProductModel(requireProduct(folder!));
    expect(result.model).toBeDefined();
    expect(result.errors).toEqual([]);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]!.file).toBe('repos/gone');
  });
});

describe('the element facts of the bundle', () => {
  function richBundle() {
    product();
    write('model/system.yaml', `version: 1

elements:
  - id: root
    kind: domain
    name: Root
  - id: mid
    kind: domain
    name: Mid
    parent: root
  - id: leaf
    kind: service
    name: Leaf
    parent: mid
  - id: lone
    kind: service

interfaces:
  - id: leaf-events
    provider: leaf
    contract: topic::leaf-events

relations:
  - id: leaf-sends-lone
    name: sends
    from: leaf
    to: lone
    interface: leaf-events
    action: send
`);
    const result = readProductModel(requireProduct(folder!));
    if (result.model === undefined) throw new Error(result.errors.map((e) => e.message).join('; '));
    return architectureBundle(result.model, result.notes, result.warnings, result.sources, new Map());
  }

  test('the relations of one end stand in code point order of the other end, then of the relation id', () => {
    product();
    write('model/system.yaml', `version: 1

elements:
  - id: hub
    kind: service
  - id: beta
    kind: service
  - id: alpha
    kind: service

relations:
  - id: hub-zeta
    name: second
    from: hub
    to: beta
  - id: hub-alpha
    name: first
    from: hub
    to: beta
  - id: hub-aaa
    name: to alpha
    from: hub
    to: alpha
`);
    const result = readProductModel(requireProduct(folder!));
    const bundle = architectureBundle(result.model!, result.notes, result.warnings, result.sources, new Map());
    const hub = bundle.model!.elements.find((element) => element.id === 'hub')!;
    expect(hub.outgoing.map((relation) => relation.relationId)).toEqual(['hub-aaa', 'hub-alpha', 'hub-zeta']);
  });

  test('a relation row carries the contract and the action; a bare relation carries neither', () => {
    const bundle = richBundle();
    const leaf = bundle.model!.elements.find((element) => element.id === 'leaf')!;
    expect(leaf.outgoing).toHaveLength(1);
    expect(leaf.outgoing[0]!.interface).toBe('topic::leaf-events');
    expect(leaf.outgoing[0]!.action).toBe('send');
    const lone = bundle.model!.elements.find((element) => element.id === 'lone')!;
    expect(lone.incoming[0]!.interface).toBe('topic::leaf-events');
    expect(lone.incoming[0]!.action).toBe('send');
  });

  test('up is the nearest ancestor with a view of its own, not just the parent', () => {
    const bundle = richBundle();
    // Views: landscape, root, mid (leaf has no children). The view of mid
    // leads up to root; a leaf has no view at all.
    const views = bundle.model!.views.map((view) => view.scope);
    expect(views).toEqual(['', 'mid', 'root']);
    const mid = bundle.model!.views.find((view) => view.scope === 'mid')!;
    expect(mid.up).toBe('root');
    const root = bundle.model!.views.find((view) => view.scope === 'root')!;
    expect(root.up).toBeUndefined();
    expect(root.opens).toEqual(['mid']);
  });

  test('an element without technology or parent carries neither field', () => {
    const bundle = richBundle();
    const lone = bundle.model!.elements.find((element) => element.id === 'lone')!;
    expect('technology' in lone).toBe(false);
    expect('parent' in lone).toBe(false);
    const leaf = bundle.model!.elements.find((element) => element.id === 'leaf')!;
    expect(leaf.technology).toBeUndefined();
    expect(leaf.parent).toBe('mid');
    expect(leaf.provides).toEqual(['topic::leaf-events']);
  });

  test('a model folder reads its files in name order', () => {
    product();
    write('model/b-second.yaml', 'version: 1\n\nelements:\n  - id: second\n    kind: service\n    parent: first\n');
    write('model/a-first.yaml', 'version: 1\n\nelements:\n  - id: first\n    kind: domain\n');
    const result = readProductModel(requireProduct(folder!));
    expect(result.errors).toEqual([]);
    expect(result.model?.elements.map((element) => element.id)).toEqual(['first', 'second']);
  });
});

describe('the conservative name rule', () => {
  test('word boundaries on both sides, dashes and dots inside the id kept whole', () => {
    expect(textNamesElement('the checkout-web serves', 'checkout-web')).toBe(true);
    expect(textNamesElement('the checkout-webx serves', 'checkout-web')).toBe(false);
    expect(textNamesElement('xcheckout-web stands', 'checkout-web')).toBe(false);
    expect(textNamesElement('(checkout-web)', 'checkout-web')).toBe(true);
    expect(textNamesElement('', 'checkout-web')).toBe(false);
  });

  test('a hyphen before or after the id is part of another word: not-shop never names shop', () => {
    expect(textNamesElement('the not-shop serves', 'shop')).toBe(false);
    expect(textNamesElement('the shop-item serves', 'shop')).toBe(false);
    expect(textNamesElement('the shop, however, serves', 'shop')).toBe(true);
    expect(textNamesElement('a-b/c names c', 'c')).toBe(true);
    expect(textNamesElement('a.b stands alone', 'b')).toBe(false);
    expect(textNamesElement('a.b stands alone', 'a.b')).toBe(true);
  });

  test('fences, inline code spans and link targets are not matches', () => {
    expect(textNamesElement('```\nshop\n```', 'shop')).toBe(false);
    expect(textNamesElement('see `shop` here', 'shop')).toBe(false);
    expect(textNamesElement('see [x](shop) here', 'shop')).toBe(false);
    expect(textNamesElement('see [x](shop "the shop") here', 'shop')).toBe(false);
    expect(textNamesElement('an [unclosed link (shop here', 'shop')).toBe(true);
    expect(textNamesElement('see [x](/p/madarch/element/shop "t") here', 'shop')).toBe(false);
    expect(textNamesElement('~~shop~~ names it', 'shop')).toBe(true);
    expect(textNamesElement('read [the shop docs](x.md) now', 'shop')).toBe(true);
  });

  test('pagesNamingElement sorts by code point and answers every matching page', () => {
    const pages = new Map([
      ['docs/b.md', 'sees shop'],
      ['docs/a.md', 'sees shop too'],
      ['docs/c.md', 'sees nothing'],
    ]);
    expect(pagesNamingElement(pages, 'shop')).toEqual(['docs/a.md', 'docs/b.md']);
  });
});

describe('the model rides the wiki revision', () => {
  test('a saved model file changes the pages revision, so the stream reports a change', () => {
    product();
    write('model/system.yaml', DRILL_DOWN);
    const wiki = requireProduct2(folder!);
    const before = wiki.pages();
    if (!before.ok) throw new Error(before.message);
    write('model/system.yaml', DRILL_DOWN + '\n\nelements:\n  - id: extra\n    kind: service\n    parent: shop\n');
    const after = wiki.pages();
    if (!after.ok) throw new Error(after.message);
    expect(after.revision).not.toBe(before.revision);
    expect(after.pages.map((page) => page.path)).toEqual(before.pages.map((page) => page.path));
  });

  test('an unchanged model keeps the same revision', () => {
    product();
    write('model/system.yaml', DRILL_DOWN);
    const wiki = requireProduct2(folder!);
    const first = wiki.pages();
    const second = wiki.pages();
    if (!first.ok || !second.ok) throw new Error('pages failed');
    expect(second.revision).toBe(first.revision);
  });
});

describe('the server routes', () => {
  test('/api/architecture answers the bundle; /api/architecture/likec4.js answers the webcomponent or its named refusal', async () => {
    product();
    write('model/system.yaml', DRILL_DOWN);
    server = startServer({ productFolder: folder!, port: 0, appFolder: join(folder!, 'app'), log: () => {}, errorLog: () => {} });
    mkdirSync(join(folder!, 'app'), { recursive: true });
    writeFileSync(join(folder!, 'app', 'index.html'), '<!doctype html><title>t</title>');
    const bundle = (await (await fetch(`${server.url}/api/architecture`)).json()) as {
      errors: { file: string; line: number; path: string; message: string }[];
      model: { elements: { id: string }[] };
      workspace: string;
    };
    expect(bundle.errors).toEqual([]);
    expect(bundle.model.elements.length).toBe(3);
    expect(bundle.workspace).toContain('view shop');
    const script = await fetch(`${server.url}/api/architecture/likec4.js`);
    const body = await script.text();
    if (script.status === 200) {
      expect(body.length).toBeGreaterThan(1_000_000);
      expect(body).toContain('customElements.define');
    } else {
      // The pinned likec4 is absent (no bun install): the refusal names it.
      expect(body).toContain('likec4');
    }
  });
});
