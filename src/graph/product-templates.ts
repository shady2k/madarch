/**
 * A product's page templates as the server reads them (decision 0036, section 6): every YAML file under `templates/`,
 * the template a catalogue entity's page opens, the record template of each kind and the template an entity opens by its
 * own id. The bootstrap answers these, so the app knows which template to compose before it asks the graph.
 *
 * A template names the pages it draws in its own file: `records: [<kind>...]` makes it that kind's record template, and
 * `entities: [<id>...]` makes it the template of those entities. The file's own name is its template name.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readTemplate, type TemplateFile } from '../page-contract/template.js';
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
  /** Every finding the files answered when they were read. */
  readonly findings: readonly TemplateFinding[];
}

/** Every file under the product's `templates/`, its template name and its text. */
function templateFiles(folder: string): { name: string; body: string; path: string }[] {
  const root = join(folder, 'templates');
  const out: { name: string; body: string; path: string }[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && statSync(path).isFile()) {
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
  return out.sort((left, right) => byCodePoint(left.name, right.name));
}

/** The product's templates and the pages they open, read from its folder. */
export function readProductTemplates(folder: string): ProductTemplates {
  const files = templateFiles(folder);
  const findings: TemplateFinding[] = [];
  const records = new Map<string, string>();
  const own = new Map<string, string>();
  const names = new Set<string>();
  for (const file of files) {
    names.add(file.name);
    const read = readTemplate(file.body, { name: file.name, file: file.path });
    findings.push(...read.findings);
    if (read.template === undefined) continue;
    for (const kind of read.template.records) records.set(kind, read.template.name);
    for (const id of read.template.entities) own.set(id, read.template.name);
  }
  return {
    templates: files.map((file) => ({ name: file.name, body: file.body })),
    catalogue: names.has(CATALOGUE_TEMPLATE_NAME) ? CATALOGUE_TEMPLATE_NAME : FALLBACK_TEMPLATE,
    records,
    own,
    findings,
  };
}

/** The template files of a product, read whole, for the start check (its findings carry file and line). */
export function readTemplateFiles(folder: string): { files: TemplateFile[]; findings: TemplateFinding[] } {
  const findings: TemplateFinding[] = [];
  const files: TemplateFile[] = [];
  for (const file of templateFiles(folder)) {
    const read = readTemplate(file.body, { name: file.name, file: file.path });
    findings.push(...read.findings);
    if (read.template !== undefined) files.push(read.template);
  }
  return { files, findings };
}
