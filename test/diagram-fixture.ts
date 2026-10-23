/**
 * The pages the diagram checks and the acceptance walk read beyond the starter set (madarch-m38l.9): kinds for the
 * entities a flow passes through (route, table, database, module, topic), each with a template that draws the
 * diagram blocks. The entity pages of every kind are madarch-m38l.6's; these exist so a diagram can be walked to its
 * ends on the generated training repository, and they are the product's own files like any template.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const KINDS = `  code.route:
    template: templates/route.md
    source: graph
    labels:
      en: { one: Route, many: Routes }
  code.table:
    template: templates/table.md
    source: graph
    labels:
      en: { one: Table, many: Tables }
  code.database:
    template: templates/database.md
    source: graph
    labels:
      en: { one: Database, many: Databases }
  code.module:
    template: templates/module.md
    source: graph
    labels:
      en: { one: Module, many: Modules }
  code.channel:
    template: templates/channel.md
    source: graph
    labels:
      en: { one: Topic, many: Topics }
`;

const TEMPLATES: Record<string, string> = {
  'templates/route.md': `:::graph{title="Around this route"}\n:::sequence{scenario="{{label}}" title="End-to-end chain"}\n`,
  'templates/table.md': `:::er{title="Table"}\n:::graph{title="Around this table"}\n`,
  'templates/database.md': `:::er{title="Tables of this database" limit=20}\n:::graph{title="Around this database"}\n`,
  'templates/module.md': `:::graph{title="Around this module"}\n`,
  'templates/channel.md': `:::graph{title="Around this topic"}\n`,
};

/** Adds the kinds and their templates to a product made by `madarch new`. */
export function addDiagramKinds(folder: string): void {
  appendFileSync(join(folder, 'madarch', 'kinds.yaml'), KINDS);
  for (const [path, text] of Object.entries(TEMPLATES)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), text);
  }
}
