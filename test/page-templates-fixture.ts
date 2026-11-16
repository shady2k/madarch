/** The page templates of a fixture product, read the two ways a fixture needs them: from the graph a page reads, and from
 *  its `templates/` folder when a test states the files itself (the engine's own page read is the graph's, only). */
import { readPublishedTemplates, templateFiles, type ProductTemplates } from '../src/graph/product-templates.js';
import { readTemplate, type TemplateFile } from '../src/page-contract/template.js';
import type { TemplateFinding } from '../src/page-contract/validate.js';
import type { KindsManifest } from '../src/product/manifest/kinds.js';
import type { SqlExecutor } from '../src/sql-driver.js';

/** What a page's context takes: the templates and the pages they open, the parsed files, their bodies and their findings. */
export interface HeldTemplates {
  readonly templates: ProductTemplates;
  readonly files: readonly TemplateFile[];
  readonly bodies: ReadonlyMap<string, string>;
  readonly findings: readonly TemplateFinding[];
}

/** The templates the graph holds, read in the transaction the test reads the page in. */
export async function readTemplatesOf(tx: SqlExecutor, manifest: KindsManifest): Promise<HeldTemplates> {
  const held = await readPublishedTemplates(tx, manifest);
  return { ...held, bodies: new Map(held.templates.templates.map((one) => [one.name, one.body])) };
}

/** The templates a fixture's `templates/` folder holds, for a test that states its files itself. */
export function readFolderTemplates(folder: string): HeldTemplates {
  const files: TemplateFile[] = [];
  const bodies = new Map<string, string>();
  const findings: TemplateFinding[] = [];
  for (const file of templateFiles(folder)) {
    const read = readTemplate(file.body, { name: file.name, file: file.path });
    findings.push(...read.findings);
    bodies.set(file.name, file.body);
    if (read.template !== undefined) files.push(read.template);
  }
  const templates = files.map((one) => ({ name: one.name, body: bodies.get(one.name) ?? '' }));
  return { templates: { templates, catalogue: 'entity', records: new Map(), own: new Map(), catalogueOf: new Map(), findings }, files, bodies, findings };
}
