import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

/**
 * The starter set `madarch new` writes into a product (decision 0029): the
 * kinds manifest and the templates for the kinds a first reader walks down —
 * the product, a domain, a service, a file and a function. From the first
 * commit they are the product's own files: the engine reads them and holds
 * no page of its own, so a product changes a page by editing its template.
 */

/** A starter file: its path in the product repository and its text. */
export interface StarterFile {
  path: string;
  content: string;
}

const KINDS = `# The kinds this product's wiki shows (decision 0029, docs/decisions/0029-knowledge-in-markdown-graph-as-index.md).
# Each kind names where its entities come from and the template that draws them:
#   source: markdown  the entity is a Markdown file of this repository (a folder of them, or one file)
#   source: graph     the entity is a node of the graph the fill builds from the code repositories
# A kind with \`file:\` is one page; the first such kind is the home page.
# \`labels\` names the kind in each interface language (en, ru): the navigation and a page's badge read it.
# \`relations\` declares an edge between kinds: {attribute|dirname} puts a part of the entity into the other end's key.
kinds:
  product:
    template: templates/product.md
    source: markdown
    file: docs/product.md
    labels:
      en: { one: Product, many: Products }
      ru: { one: Продукт, many: Продукты }
  domain:
    template: templates/domain.md
    source: markdown
    folder: docs/domains
    labels:
      en: { one: Domain, many: Domains }
      ru: { one: Домен, many: Домены }
  code.service:
    template: templates/service.md
    source: graph
    labels:
      en: { one: Service, many: Services }
      ru: { one: Сервис, many: Сервисы }
    relations:
      - { type: code.contains, to: "code.package:{span.path|dirname}" }
  code.file:
    template: templates/file.md
    source: graph
    labels:
      en: { one: File, many: Files }
      ru: { one: Файл, many: Файлы }
  code.symbol:
    template: templates/symbol.md
    source: graph
    labels:
      en: { one: Symbol, many: Symbols }
      ru: { one: Символ, many: Символы }
`;

const PRODUCT = `:::body
:::system{title="The system"}
:::treemap{title="Files by size and change"}
:::related{title="Relates to" relation="relates"}
`;

const DOMAIN = `:::body
:::sequence{scenario="{{title}}" title="End-to-end chain"}
:::graph{title="Around this page"}
:::related{title="Implemented by" relation="relates"}
`;

const SERVICE = `A {{language}} service. Frameworks: {{frameworks}}. Infrastructure: {{infrastructure}}. Tests: {{testFramework}}.

:::graph{title="Around this service"}
:::modules{title="Modules"}
:::treemap{title="Files by size and change"}
:::related{title="Files" relation="code.contains" depth=3 kind="code.file" limit=60}
:::related{title="Pages about this service" relation="relates"}
`;

const FILE = `{{path}}

:::source
:::graph{title="Around this file"}
:::related{title="Declares" relation="code.contains" direction="out" kind="code.symbol" limit=60}
:::related{title="Imports" relation="code.imports" direction="out"}
:::related{title="Imported by" relation="code.imports" direction="in"}
:::related{title="Pages about this file" relation="relates"}
`;

const SYMBOL = `{{symbolKind}} in {{path}}

:::source
:::graph{title="Around this function"}
:::sequence{scenario="{{label}}" title="End-to-end chain"}
:::callers
:::callees{title="Calls"}
:::related{title="Tests and types" relation="code.tests,code.implements,code.inherits"}
:::related{title="Pages about this function" relation="relates"}
`;

export const STARTER_FILES: readonly StarterFile[] = [
  { path: 'madarch/kinds.yaml', content: KINDS },
  { path: 'templates/product.md', content: PRODUCT },
  { path: 'templates/domain.md', content: DOMAIN },
  { path: 'templates/service.md', content: SERVICE },
  { path: 'templates/file.md', content: FILE },
  { path: 'templates/symbol.md', content: SYMBOL },
];

/**
 * Writes the starter set into a product that has none: the files that are absent, never one that is there. Answers the
 * paths it wrote. An error names the file that could not be written.
 */
export function seedStarterSet(productFolder: string): string[] {
  const written: string[] = [];
  const root = realpathSync(productFolder);
  for (const starter of STARTER_FILES) {
    const target = join(productFolder, starter.path);
    if (existsSync(target) || lstatSync(target, { throwIfNoEntry: false }) !== undefined) continue;
    // A folder of the product that is a link out of it would take the file somewhere else: refused, naming it.
    let ancestor = dirname(target);
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    const real = realpathSync(ancestor);
    if (real !== root && !real.startsWith(`${root}${sep}`)) {
      throw new Error(`src/knowledge/seed.ts: ${ancestor} is a link to ${real}, outside the product ${productFolder}: ${target} was not written, and the starter set is not given to this product`);
    }
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, starter.content, { flag: 'wx' });
    } catch (error) {
      throw new Error(`src/knowledge/seed.ts: ${target} could not be written to give the product its starter set: ${(error as Error).message}`);
    }
    written.push(starter.path);
  }
  return written;
}
