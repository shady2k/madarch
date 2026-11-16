/**
 * A product's page templates as the server reads them (decision 0036, section 6): every YAML file under `templates/`,
 * the template a catalogue entity's page opens, the record template of each kind and the template an entity opens by its
 * own id. The bootstrap answers these, so the app knows which template to compose before it asks the graph.
 *
 * A template names the pages it draws in its own file: `records: [<kind>...]` makes it that kind's record template,
 * `entities: [<id>...]` makes it the template of those entities, and `catalogue: [<kind>...]` makes it the page of that
 * kind's catalogue entry. The file's own name is its template name.
 */
import { withSpanSync } from '../obs/trace.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readTemplate, type TemplateFile } from '../page-contract/template.js';
import { generatedTableName } from './contract.js';
import { startSpan } from '../obs/trace.js';
import { pageTemplateKind, type KindsManifest } from '../product/manifest/kinds.js';
import { cataloguePageTemplate } from '../knowledge/page-template-kind.js';
import type { SqlExecutor } from '../sql-driver.js';
import { byCodePoint } from '../model/order.js';
import type { TemplateFinding } from '../page-contract/validate.js';

/** The template a catalogue entity's page opens when the product holds no template of its own for it. */
export const FALLBACK_TEMPLATE = 'entity';

/** The name a product gives the catalogue's own page template. */
export const CATALOGUE_TEMPLATE_NAME = 'catalogue-entity';

/** A product's templates and the pages they open. */
export interface ProductTemplates {
  /** Every template of the product, named by its path under `templates/` without its extension. */
  readonly templates: readonly { readonly name: string; readonly body: string }[];
  /** The template a catalogue entity's page opens. */
  readonly catalogue: string;
  /** Each kind's record template, by kind name. */
  readonly records: ReadonlyMap<string, string>;
  /** The template an entity opens by its own id. */
  readonly own: ReadonlyMap<string, string>;
  /** The template a kind's catalogue entry opens, by kind name. */
  readonly catalogueOf: ReadonlyMap<string, string>;
  /** Every finding the files answered when they were read. */
  readonly findings: readonly TemplateFinding[];
}

/** Every file under the product's `templates/`, its template name, its text and its product-relative path. */
export function templateFiles(folder: string): { name: string; body: string; path: string }[] {
  const root = join(folder, 'templates');
  const out: { name: string; body: string; path: string }[] = [];
  return withSpanSync('templates.read', { 'file.path': root }, (span) => {
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      // Section 6: a page template is a YAML file of `templates/`. Another file beside them (a product's leftover
      // Liquid template) is no page template, and the server neither reads it nor refuses the product for it.
      else if (entry.isFile() && statSync(path).isFile() && /\.ya?ml$/u.test(entry.name)) {
        const name = relative(root, path).replace(/\.[^.]*$/u, '');
        out.push({ name, body: readFileSync(path, 'utf8'), path: `templates/${relative(root, path)}` });
      }
    }
  };
  try {
    visit(root);
  } catch {
    return [];
  }
  span.setAttribute('templates.files', out.length);
  return out.sort((left, right) => byCodePoint(left.name, right.name));
  });
}

/**
 * The pages one set of template files opens: the bootstrap's template list and the kinds, entities and catalogue entries
 * they are bound to. The files come from the graph (their bodies were published at start), never from the folder: the
 * reader of a page holds no checkout.
 */
export function templatesOf(files: readonly TemplateFile[], bodies: ReadonlyMap<string, string>, findings: readonly TemplateFinding[] = []): ProductTemplates {
  const records = new Map<string, string>();
  const own = new Map<string, string>();
  const catalogueOf = new Map<string, string>();
  const names = new Set<string>();
  for (const file of files) {
    names.add(file.name);
    for (const kind of file.records) records.set(kind, file.name);
    for (const id of file.entities) own.set(id, file.name);
    for (const kind of file.catalogue) catalogueOf.set(kind, file.name);
  }
  return {
    templates: files.map((file) => ({ name: file.name, body: bodies.get(file.name) ?? '' })),
    catalogue: names.has(CATALOGUE_TEMPLATE_NAME) ? CATALOGUE_TEMPLATE_NAME : FALLBACK_TEMPLATE,
    records,
    own,
    catalogueOf,
    findings: [...findings],
  };
}

/**
 * The product's page templates as the graph holds them (the owner's decision of 2026-11-15; decision 0036, section 6): the
 * kind its manifest declares with a `page-template:` role holds one entity per template, with its body as a field of that
 * kind. Read inside the page's own snapshot, so a page sees one revision of its templates, and never from a folder.
 */
export async function readPublishedTemplates(executor: SqlExecutor, manifest: KindsManifest): Promise<{ templates: ProductTemplates; files: readonly TemplateFile[]; findings: readonly TemplateFinding[] }> {
  // The product's own kind wins; a product whose manifest names none publishes its templates as the catalogue's kind.
  const kind = pageTemplateKind(manifest);
  const declared = kind?.pageTemplate;
  const fallback = cataloguePageTemplate();
  const kindName = kind?.name ?? fallback.name;
  const nameRole = declared?.['name'] ?? fallback.nameField;
  const bodyRole = declared?.['body'] ?? fallback.bodyField;
  const pathRole = declared?.['path'] ?? fallback.pathField;
  const column = (field: string): string => `"${field.replaceAll('"', '""')}"`;
  // A template is one page drawing another: its rows are the kind's, and the body is a declared text field.
  const span = startSpan('graph.templates.read', { 'madarch.kinds': String(manifest.kinds.size) });
  let found: { readonly rows: readonly { readonly name: string | null; readonly body: string | null; readonly path: string | null }[] };
  try {
    found = await executor.query<{ name: string | null; body: string | null; path: string | null }>(
    `SELECT n.key->>$1 AS name, o.${column(bodyRole)} AS body, ${pathRole === undefined ? 'NULL' : `o.${column(pathRole)}`} AS path
       FROM ${generatedTableName(kindName, 'vertex')} o JOIN node n ON n.id = o.node_id
      WHERE o.state = 'open' AND o.context_id = 1 AND n.context_id = 1 AND NOT n.removed
      ORDER BY n.key->>$1`, [nameRole]);
  } finally { span.end(); }
  const files: TemplateFile[] = [];
  const bodies = new Map<string, string>();
  const findings: TemplateFinding[] = [];
  for (const row of found.rows) {
    if (typeof row.name !== 'string' || row.name === '' || typeof row.body !== 'string') continue;
    // The file a template's name opens, product-relative as `templateFiles` names it: the findings' file names are read
    // against the product folder once, and the graph holds no second path.
    const file = row.path ?? `templates/${row.name}.yaml`;
    const read = readTemplate(row.body, { name: row.name, file });
    findings.push(...read.findings);
    bodies.set(row.name, row.body);
    if (read.template !== undefined) files.push(read.template);
  }
  return { templates: templatesOf(files, bodies, findings), files, findings };
}

