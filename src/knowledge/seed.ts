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
# \`relations\` declares an edge between kinds: {attribute|dirname} puts a part of the entity into the other end's key.
kinds:
  product:
    template: templates/product.md
    source: markdown
    file: docs/product.md
  domain:
    template: templates/domain.md
    source: markdown
    folder: docs/domains
  code.service:
    template: templates/service.md
    source: graph
    relations:
      - { type: code.contains, to: "code.package:{span.path|dirname}" }
  code.file:
    template: templates/file.md
    source: graph
  code.symbol:
    template: templates/symbol.md
    source: graph
`;

const PRODUCT = `:::body
:::related{title="Relates to" relation="relates"}
`;

const DOMAIN = `:::body
:::related{title="Implemented by" relation="relates"}
`;

const SERVICE = `A {{language}} service. Frameworks: {{frameworks}}. Infrastructure: {{infrastructure}}. Tests: {{testFramework}}.

:::graph{depth=1 title="Links"}
:::related{title="Files" relation="code.contains" depth=3 kind="code.file" limit=60}
:::related{title="Pages about this service" relation="relates"}
`;

const FILE = `{{path}}

:::source
:::related{title="Declares" relation="code.contains" direction="out" kind="code.symbol" limit=60}
:::related{title="Imports" relation="code.imports" direction="out"}
:::related{title="Imported by" relation="code.imports" direction="in"}
:::related{title="Pages about this file" relation="relates"}
`;

const SYMBOL = `{{symbolKind}} in {{path}}

:::source
:::callers
:::callees{title="Calls"}
:::sequence{depth=2}
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
