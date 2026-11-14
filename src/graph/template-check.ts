/**
 * A product's page templates checked at start (decision 0036, sections 6 and 9): every file is read against the
 * template schema, its inheritance is resolved, and the operation each bound template composes is validated against the
 * schema the product's manifest derives. A template naming an unknown component or parameter, a section placed after a
 * section the page does not hold, or a query a type of the product cannot answer is refused with the file and the line.
 *
 * The bindings checked are the ones the product declares: its kinds' record templates, its catalogue and home
 * templates, and the base `entity` every unbound kind falls back to (against every kind).
 */
import { buildSchema, parse, validate } from 'graphql';
import { publishedManifestOf } from '../graphql/manifest.js';
import { graphqlSchemaOf } from '../graphql/schema.js';
import { homeKind, readKinds } from '../product/manifest/kinds.js';
import { byCodePoint } from '../model/order.js';
import { composePage, templateFor, type Bootstrap, type PageAddress } from '../page-contract/compose.js';
import { resolveTemplate, type TemplateFile } from '../page-contract/template.js';
import type { TemplateFinding } from '../page-contract/validate.js';
import { readProductTemplates, readTemplateFiles, type ProductTemplates } from './product-templates.js';

/** The address a template is checked at: an id stands in for the page's entity, which the validity of a query never reads. */
const PLACEHOLDER_ID = '00000000-0000-0000-0000-000000000000';

/** The bootstrap a check composes with: the product's own templates and the pages they open, and nothing else. */
function bootstrapOf(templates: ProductTemplates): Bootstrap {
  return {
    structureRevision: '',
    home: null,
    catalogueTemplate: templates.catalogue,
    templates: templates.templates,
    recordTemplates: [...templates.records.entries()].map(([kind, template]) => ({ kind, template })),
    ownTemplates: [...templates.own.entries()].map(([id, template]) => ({ id, template })),
    roles: [],
  };
}

/** Every finding of a product's templates: the files' own, their inheritance's, and each bound page against the schema. */
export function checkProductTemplates(folder: string): TemplateFinding[] {
  const files = readTemplateFiles(folder);
  const findings: TemplateFinding[] = [...files.findings];
  const read = readKinds(folder);
  if (!read.present) return findings;
  // A product with no templates draws no page: nothing of its own is checked, and nothing is refused for it.
  if (files.files.length === 0 && files.findings.length === 0) return findings;
  const templates = readProductTemplates(folder);
  const byName = new Map<string, TemplateFile>(files.files.map((one) => [one.name, one]));
  // Inheritance: every template of the product resolves, bound or not, so a broken base is named where it stands.
  for (const template of files.files) findings.push(...resolveTemplate(template.name, byName).findings);
  const bootstrap = bootstrapOf(templates);
  const schema = buildSchema(graphqlSchemaOf(publishedManifestOf(read.manifest)));
  const lineOfSection = (template: string, alias: string): TemplateFinding => {
    const section = byName.get(template)?.sections.find((one) => `s_${one.id}` === alias);
    return { file: `templates/${template}.yaml`, line: section?.line ?? 1, path: `sections.${section?.id ?? alias}`, message: '' };
  };
  const check = (address: PageAddress, template: string, at: string): void => {
    const composition = composePage(bootstrap, address);
    for (const finding of composition.findings) findings.push({ ...finding, message: `${at}: ${finding.message}` });
    if (composition.findings.length > 0 || composition.operation === '') return;
    let document;
    try {
      document = parse(composition.operation);
    } catch (error) {
      findings.push({ file: `templates/${template}.yaml`, line: 1, path: '', message: `${at}: the composed operation does not parse: ${(error as Error).message}` });
      return;
    }
    for (const error of validate(schema, document)) {
      const alias = typeof error.path?.[0] === 'string' ? error.path[0] : '';
      const place = alias === '' ? { file: `templates/${template}.yaml`, line: 1, path: '' } : lineOfSection(template, alias);
      findings.push({ ...place, message: `${at}: ${error.message}` });
    }
  };
  const bound = new Set<string>();
  for (const kind of [...templates.records.keys()].sort(byCodePoint)) {
    const template = templates.records.get(kind)!;
    bound.add(template);
    check({ template, kind, id: PLACEHOLDER_ID }, template, `the record template of the kind "${kind}"`);
  }
  // The catalogue's page is the product's own template; checked against the type the graph answers it as.
  check({ template: templates.catalogue, kind: 'catalogue', id: PLACEHOLDER_ID }, templates.catalogue, 'the catalogue template');
  const home = homeKind(read.manifest);
  if (home !== undefined) check({ template: templateFor(bootstrap, { home: true }), kind: home.name, id: PLACEHOLDER_ID, home: true }, templateFor(bootstrap, { home: true }), 'the home template');
  // The fallback: every kind a record template leaves unbound opens `entity`.
  const unbound = [...read.manifest.kinds.keys()].sort(byCodePoint).filter((kind) => !templates.records.has(kind));
  if (unbound.length > 0 && !byName.has('entity')) {
    findings.push({ file: 'templates/entity.yaml', line: 1, path: '', message: 'the base template "entity" is missing: a kind without a record template opens it' });
  }
  for (const kind of unbound) check({ kind, id: PLACEHOLDER_ID }, 'entity', `the kind "${kind}" opens the base entity template`);
  // One finding per line and message: a base template used by a hundred kinds says each thing once.
  const seen = new Set<string>();
  return findings.filter((one) => {
    const key = `${one.file}\u0000${String(one.line)}\u0000${one.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The refusal a server states when a product's templates cannot be used, or undefined when they all can. */
export function productTemplateRefusal(folder: string): string | undefined {
  const findings = checkProductTemplates(folder);
  if (findings.length === 0) return undefined;
  return findings.map((one) => `${folder}/${one.file}:${String(one.line)}: ${one.message}`).join('\n');
}
