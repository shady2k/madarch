/**
 * A product's page templates as the server reads them (decision 0036, section 6): every YAML file under `templates/`,
 * the template a catalogue entity's page opens, the record template of each kind and the template an entity opens by its
 * own id. The bootstrap answers these, so the app knows which template to compose before it asks the graph.
 *
 * A template names the pages it draws in its own file: `records: [<kind>...]` makes it that kind's record template,
 * `entities: [<id>...]` makes it the template of those entities, and `catalogue: [<kind>...]` makes it the page of that
 * kind's catalogue entry. The file's own name is its template name.
 */
import { readTemplate, type TemplateFile } from '../page-contract/template.js';
import { readKindAssertions } from './records.js';
import { graphContractOf } from '../fill/stages/plugin-contract.js';
import { withManifestContract } from './manifest-contract.js';
import { withAssertionContract } from './system-contract.js';
import { startSpan } from '../obs/trace.js';
import type { KindsManifest } from '../product/manifest/kinds.js';
import { productPageTemplate } from '../knowledge/page-template-kind.js';
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
  const { name: kindName, nameField: nameRole, bodyField: bodyRole, pathField: pathRole } = productPageTemplate(manifest);
  const contract = withAssertionContract(withManifestContract(graphContractOf(manifest)));
  const span = startSpan('graph.templates.read', { 'madarch.kinds': String(manifest.kinds.size) });
  let rows: Awaited<ReturnType<typeof readKindAssertions>>;
  try {
    rows = await readKindAssertions(executor, 'vertex', kindName, [bodyRole, ...(pathRole === undefined ? [] : [pathRole])], { contract });
  } finally { span.end(); }
  const found = rows.map(row => ({ name: row.key[nameRole], body: row.values[bodyRole], path: pathRole === undefined ? undefined : row.values[pathRole] }))
    .sort((left, right) => byCodePoint(String(left.name), String(right.name)));
  const files: TemplateFile[] = [];
  const bodies = new Map<string, string>();
  const findings: TemplateFinding[] = [];
  for (const row of found) {
    if (typeof row.name !== 'string' || row.name === '' || typeof row.body !== 'string') continue;
    // The file a template's name opens, product-relative as `templateFiles` names it: the findings' file names are read
    // against the product folder once, and the graph holds no second path.
    const file = typeof row.path === 'string' ? row.path : `templates/${row.name}.yaml`;
    const read = readTemplate(row.body, { name: row.name, file });
    findings.push(...read.findings);
    bodies.set(row.name, row.body);
    if (read.template !== undefined) files.push(read.template);
  }
  return { templates: templatesOf(files, bodies, findings), files, findings };
}
