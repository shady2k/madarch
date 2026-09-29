import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanStarlightSource, ensureStarlightInstall, linkStarlightNodeModules, STARLIGHT_TEMPLATE_DIR } from '../src/wiki/starlight.js';
import type { WikiPage } from '../src/wiki/pages.js';
import { preparePages, renderPageBody, type WikiDiagramAsset } from '../src/wiki/render.js';
import { pageRoute, starlightLinks, starlightSidebar, starlightSlug, writeStarlightProject, STARLIGHT_CACHE_ROOT } from '../src/wiki/starlight.js';

/**
 * The Starlight writer's pure parts (src/wiki/starlight.ts): the slug rule
 * mirrored from the engine's own slugger, the page id → route mapping, the
 * sidebar built from the shared nav tree, and the pages' rendering with
 * Starlight links — every one deterministic, none needing the engine
 * installed. The real Starlight build is a separate, gated concern.
 */

const DIAGRAMS = new Map<string, WikiDiagramAsset>([
  ['', { likec4: 'index', mermaid: 'flowchart LR', table: { columns: [], rows: [] } }],
  ['ordering', { likec4: 'ordering', mermaid: 'flowchart LR', table: { columns: ['Relations'], rows: [['takes payment']] } }],
]);

const PAGES: readonly WikiPage[] = [
  { id: 'home', title: 'Home', nav: [], blocks: [{ kind: 'diagram' }] },
  { id: 'domain/ordering', title: 'Ordering', nav: ['Domains'], blocks: [{ kind: 'paragraph', text: 'The Ordering domain holds 1 element.' }, { kind: 'diagram', scope: 'ordering' }] },
  {
    id: 'element/checkout',
    title: 'Checkout',
    nav: ['Domains', 'Ordering'],
    blocks: [{ kind: 'table', columns: ['Zone', 'Relations'], rows: [[{ page: 'zone/internal', text: 'Internal network' }, [{ page: 'interfaces', anchor: 'grpc', text: 'grpc' }]]] }],
  },
  { id: 'interfaces', title: 'Interfaces', nav: ['Interfaces'], blocks: [{ kind: 'heading', level: 2, text: 'grpc' }] },
  { id: 'zones', title: 'Zones', nav: ['Zones'], blocks: [] },
  { id: 'zone/internal', title: 'Internal network', nav: ['Zones'], blocks: [] },
  { id: 'data-categories', title: 'Data categories', nav: ['Data categories'], blocks: [] },
  { id: 'data-category/personal', title: 'Personal data', nav: ['Data categories'], blocks: [] },
];

describe('starlightSlug', () => {
  // Every case pins the mirror of github-slugger 2.0.0 — the rule
  // Starlight's Markdown pipeline spells heading anchors by — including
  // the behaviours a tidier rule would get wrong.
  test('lowercases and dashes plain heading text', () => {
    expect(starlightSlug('Provided interfaces')).toBe('provided-interfaces');
    expect(starlightSlug('PCI DSS cardholder data environment')).toBe('pci-dss-cardholder-data-environment');
    expect(starlightSlug('grpc')).toBe('grpc');
  });
  test('drops punctuation, keeps letters, digits, underscores and dashes', () => {
    expect(starlightSlug('C++ clients')).toBe('c-clients');
    expect(starlightSlug('R&D')).toBe('rd');
    expect(starlightSlug('a_b')).toBe('a_b');
    expect(starlightSlug('Already-kebab')).toBe('already-kebab');
    expect(starlightSlug('Zone: DMZ (old)')).toBe('zone-dmz-old');
  });
  test('is the engine rule, not a tidier one: every space a dash, no trim', () => {
    expect(starlightSlug('a  b')).toBe('a--b');
    expect(starlightSlug('a ')).toBe('a-');
  });
  test('keeps non-ASCII letters, case-folded', () => {
    expect(starlightSlug('Ångström')).toBe('ångström');
  });
});

describe('pageRoute', () => {
  test('maps page ids to root-relative route URLs of the built site', () => {
    expect(pageRoute('home')).toBe('/');
    expect(pageRoute('domain/ordering')).toBe('/domains/ordering/');
    expect(pageRoute('zone/internal')).toBe('/zones/internal/');
    expect(pageRoute('data-category/personal')).toBe('/data-categories/personal/');
    expect(pageRoute('interfaces')).toBe('/interfaces/');
  });
  test('refuses an id no page file exists for', () => {
    expect(() => pageRoute('note/orders')).toThrow('unknown kind');
  });
});

describe('starlightSidebar', () => {
  test('builds the sidebar from the shared nav tree: Home first, then one group per section', () => {
    expect(starlightSidebar(PAGES)).toEqual([
      { label: 'Home', link: '/' },
      { label: 'Domains', items: [{ label: 'Ordering', items: ['domains/ordering', 'elements/checkout'] }] },
      { label: 'Interfaces', items: ['interfaces'] },
      { label: 'Zones', items: ['zones', 'zones/internal'] },
      { label: 'Data categories', items: ['data-categories', 'data-categories/personal'] },
    ]);
  });
});

describe('starlight page rendering', () => {
  const prepared = preparePages(PAGES);

  test('renders Starlight links: root-relative routes and slugged anchors', () => {
    const checkout = PAGES[2]!;
    const text = renderPageBody(checkout, { diagrams: DIAGRAMS, firstTab: 'likec4' }, prepared, starlightLinks);
    expect(text).toContain('[Internal network](/zones/internal/)');
    expect(text).toContain('[grpc](/interfaces/#grpc)');
  });
  test('refuses a link naming a page or a heading the wiki does not hold', () => {
    const broken: WikiPage = { id: 'zone/internal', title: 'Internal network', nav: ['Zones'], blocks: [{ kind: 'table', columns: ['X'], rows: [[{ page: 'zone/ghost', text: 'Ghost' }]] }] };
    expect(() => renderPageBody(broken, { diagrams: DIAGRAMS, firstTab: 'likec4' }, prepared, starlightLinks)).toThrow('links to "zone/ghost", which is not a page of this wiki');
    const noHeading: WikiPage = { id: 'zone/internal', title: 'Internal network', nav: ['Zones'], blocks: [{ kind: 'table', columns: ['X'], rows: [[{ page: 'interfaces', anchor: 'absent', text: 'x' }]] }] };
    expect(() => renderPageBody(noHeading, { diagrams: DIAGRAMS, firstTab: 'likec4' }, prepared, starlightLinks)).toThrow('at the heading "absent"');
  });
  test('renders the diagram tabs with the view the page belongs to', () => {
    const ordering = PAGES[1]!;
    const text = renderPageBody(ordering, { diagrams: DIAGRAMS, firstTab: 'likec4' }, prepared, starlightLinks);
    expect(text).toContain('data-first="likec4"');
    expect(text).toContain('<likec4-view view-id="ordering"></likec4-view>');
    expect(text).toContain('class="mermaid"');
  });
});

describe('the template install and its cache', () => {
  function fakeBunDir(): string {
    const dir = join(mkdtempSync(join(tmpdir(), 'madarch-fakebun-')), 'bin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'bun'),
      '#!/bin/sh\ncase "$1" in\n  --version) printf "1.4.2-fake\\n" ;;\n  install) mkdir -p node_modules/.bin && : > node_modules/.bin/astro ;;\nesac\n',
      { mode: 0o755 },
    );
    return dir;
  }

  test('refuses a template folder that is not there, naming the path', () => {
    const absent = join(tmpdir(), 'madarch-absent-template');
    const result = ensureStarlightInstall(absent, join(tmpdir(), 'madarch-cache-x'));
    expect(result).toEqual({ ok: false, message: expect.stringContaining(absent) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('restore it there');
  });

  test('refuses a failed install naming the cause and the install output', () => {
    const bin = join(mkdtempSync(join(tmpdir(), 'madarch-failbun-')), 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'bun'), '#!/bin/sh\ncase "$1" in\n  --version) printf "1.4.2-fake\\n" ;;\n  install) printf "bun install exploded\\n" >&2; exit 1 ;;\nesac\n', { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
    try {
      const result = ensureStarlightInstall(STARLIGHT_TEMPLATE_DIR, join(mkdtempSync(join(tmpdir(), 'madarch-cache-')), 'cache'));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain('could not be installed');
        expect(result.message).toContain('failed (exit 1)');
        expect(result.message).toContain('bun install exploded');
      }
    } finally {
      process.env.PATH = savedPath;
    }
  });

  test('refuses a missing bun naming how to install it, before writing anything', () => {
    const savedPath = process.env.PATH;
    process.env.PATH = mkdtempSync(join(tmpdir(), 'madarch-empty-'));
    const cache = join(mkdtempSync(join(tmpdir(), 'madarch-cache-')), 'cache');
    try {
      const result = ensureStarlightInstall(STARLIGHT_TEMPLATE_DIR, cache);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain('bun');
        expect(result.message).toContain('bun.sh');
      }
      expect(existsSync(cache)).toBe(false);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  test('installs the template once into the cache the first time, and skips the second', () => {
    const bin = fakeBunDir();
    const cache = join(mkdtempSync(join(tmpdir(), 'madarch-cache-')), 'cache');
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
    try {
      const first = ensureStarlightInstall(STARLIGHT_TEMPLATE_DIR, cache);
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error('the install must succeed');
      expect(first.project.startsWith(cache)).toBe(true);
      expect(existsSync(join(first.project, 'node_modules', '.bin', 'astro'))).toBe(true);
      expect(readFileSync(join(first.project, 'package.json'), 'utf8')).toContain('madarch-wiki-starlight');
      // A sentinel beside the install marker: the second call must skip the
      // install and leave it exactly as the first one left it.
      writeFileSync(join(first.project, 'node_modules', 'sentinel'), 'kept');
      const second = ensureStarlightInstall(STARLIGHT_TEMPLATE_DIR, cache);
      expect(second).toEqual(first);
      expect(readFileSync(join(first.project, 'node_modules', 'sentinel'), 'utf8')).toBe('kept');
    } finally {
      process.env.PATH = savedPath;
    }
  });

  test('the same template digests to one cache folder, a changed template to another', () => {
    const bin = fakeBunDir();
    const cache = join(mkdtempSync(join(tmpdir(), 'madarch-cache-')), 'cache');
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
    try {
      const template = join(mkdtempSync(join(tmpdir(), 'madarch-tpl-')), 'starlight');
      cpDirectory(STARLIGHT_TEMPLATE_DIR, template);
      const one = ensureStarlightInstall(template, cache);
      const two = ensureStarlightInstall(template, cache);
      expect(one.ok && two.ok && one.project).toBe(two.ok && two.project);
      writeFileSync(join(template, 'package.json'), '{}\n');
      const changed = ensureStarlightInstall(template, cache);
      expect(one.ok && changed.ok && one.project !== changed.project).toBe(true);
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

describe('the engine build seams', () => {
  test('linkStarlightNodeModules points node_modules at the install; cleanStarlightSource removes the link and caches, never the target', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'madarch-link-')), 'project');
    const cache = join(mkdtempSync(join(tmpdir(), 'madarch-link-')), 'cache');
    mkdirSync(join(cache, 'node_modules'), { recursive: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'marker.txt'), 'kept');
    linkStarlightNodeModules(cache, dir);
    expect(readlinkSync(join(dir, 'node_modules'))).toBe(join(cache, 'node_modules'));
    cleanStarlightSource(dir);
    mkdirSync(join(dir, '.astro'), { recursive: true });
    symlinkSync(cache, join(dir, 'node_modules'), 'dir');
    cleanStarlightSource(dir);
    expect(existsSync(join(dir, '.astro'))).toBe(false);
    expect(existsSync(join(dir, 'node_modules'))).toBe(false);
    expect(existsSync(join(cache, 'node_modules'))).toBe(true);
    expect(readFileSync(join(dir, 'marker.txt'), 'utf8')).toBe('kept');
  });
});

function cpDirectory(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) cpDirectory(source, target);
    else writeFileSync(target, readFileSync(source));
  }
}

describe('writeStarlightProject', () => {
  const OPTIONS = { siteName: 'reference-system', diagrams: DIAGRAMS, firstTab: 'likec4' as const };

  test('escapes backslashes and quotes in the frontmatter title', () => {
    const page: WikiPage = { id: 'zone/internal', title: 'a"b\\c', nav: ['Zones'], blocks: [] };
    const dir = join(mkdtempSync(join(tmpdir(), 'madarch-frontmatter-')), 'source');
    writeStarlightProject([page], dir, OPTIONS);
    const text = readFileSync(join(dir, 'src', 'content', 'docs', 'zones', 'internal.md'), 'utf8');
    expect(text.startsWith('---\ntitle: "a\\"b\\\\c"\n---\n')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  function project(): string {
    return join(mkdtempSync(join(tmpdir(), 'madarch-starlight-')), 'source');
  }

  test('writes the template, every page with frontmatter, the site module, the stylesheet and the diagram module', () => {
    const dir = project();
    writeStarlightProject(PAGES, dir, OPTIONS);
    // The template's own files, copied untouched.
    expect(readFileSync(join(dir, 'astro.config.mjs'), 'utf8')).toBe(readFileSync(new URL('../wiki/starlight/astro.config.mjs', import.meta.url), 'utf8'));
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toContain('"astro"');
    expect(exists(join(dir, 'bun.lock'))).toBe(true);
    expect(exists(join(dir, 'src', 'content.config.ts'))).toBe(true);
    expect(exists(join(dir, 'public', 'favicon.svg'))).toBe(true);
    // The pages, under the shared page paths.
    const home = readFileSync(join(dir, 'src', 'content', 'docs', 'index.md'), 'utf8');
    expect(home.startsWith('---\ntitle: "Home"\n---\n')).toBe(true);
    expect(home).toContain('# Home');
    expect(home).toContain('<likec4-view view-id="index"></likec4-view>');
    expect(exists(join(dir, 'src', 'content', 'docs', 'zones', 'internal.md'))).toBe(true);
    expect(exists(join(dir, 'src', 'content', 'docs', 'domains', 'ordering.md'))).toBe(true);
    // The generated site module: title and sidebar for astro.config.mjs.
    const site = readFileSync(join(dir, 'src', 'generated', 'site.mjs'), 'utf8');
    expect(site).toContain('"title": "reference-system"');
    expect(site).toContain('"label": "Zones"');
    expect(site).toContain('"data-categories/personal"');
    // The stylesheet: the engine's container rule first, the shared tab rules after, block comments only.
    const css = readFileSync(join(dir, 'src', 'styles', 'wiki.css'), 'utf8');
    expect(css.indexOf('.main-pane')).toBeLessThan(css.indexOf('.wiki-panel[data-panel="likec4"]'));
    expect(css.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('//');
    // The diagram module, finding the runtime the build ships beside it.
    expect(readFileSync(join(dir, 'public', 'wiki-diagram.mjs'), 'utf8')).toContain("import mermaid from './assets/mermaid/mermaid.esm.min.mjs';");
    rmSync(dir, { recursive: true, force: true });
  });

  test('two runs give byte-identical projects', () => {
    const first = project();
    const second = project();
    writeStarlightProject(PAGES, first, OPTIONS);
    writeStarlightProject(PAGES, second, OPTIONS);
    const entries = (dir: string): [string, string][] =>
      walk(dir).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    expect(entries(first)).toEqual(entries(second));
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  });

  test('the install cache sits outside the repository and the out folder', () => {
    expect(STARLIGHT_CACHE_ROOT).toBe(join(tmpdir(), 'madarch-wiki-starlight'));
    expect(STARLIGHT_CACHE_ROOT.includes(process.cwd())).toBe(false);
  });

  test('the stylesheet pins the container rule on the engine pane', () => {
    const dir = project();
    writeStarlightProject(PAGES, dir, OPTIONS);
    const css = readFileSync(join(dir, 'src', 'styles', 'wiki.css'), 'utf8');
    expect(css).toContain('.main-pane {\n  container-type: inline-size;\n}');
    rmSync(dir, { recursive: true, force: true });
  });
});

function exists(path: string): boolean {
  return readdirSync(join(path, '..')).includes(justName(path));
}

function justName(path: string): string {
  return path.split('/').pop()!;
}

function walk(root: string): [string, string][] {
  const files: [string, string][] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else files.push([full.slice(root.length + 1), readFileSync(full, 'utf8')]);
    }
  };
  visit(root);
  return files;
}
