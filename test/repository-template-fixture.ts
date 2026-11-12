import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import type { TemplatePart } from '../src/knowledge/template.js';
import { publishFixtureTemplate } from './structured-template-fixture.js';

const block = (name: Extract<TemplatePart, { type: 'block' }>['name'], params: Record<string, string> = {}): TemplatePart => ({ type: 'block', name, params, line: 1 });
const details = block('properties', { title: 'Details', 'title-ru': 'Сведения' });
const around = (title: string): TemplatePart => block('relations', { title });
const pagesAbout = (title: string): TemplatePart => block('related', { title, relation: 'relates' });
const mentioned = block('linkedfrom', { title: 'Mentioned on', 'hide-empty': 'true' });

/** Hand-authored graph layouts for native-only repository fixtures; no Liquid reader or agent stage is involved. */
export async function publishRepositoryFixtureTemplates(owner: DatabaseOwner, product: string): Promise<void> {
  const layouts: Record<string, readonly TemplatePart[]> = {
    repository: [
      block('treemap', { title: 'Repository map', colour: 'heat', window: '90d' }),
      block('repository', { title: 'Repository' }), around('Around this repository'),
      block('files', { title: 'Files', colour: 'heat', window: '90d' }),
      block('history', { title: 'History' }), block('folder', { title: 'Root' }),
      block('related', { title: 'Files', relation: 'code.contains', depth: '3', kind: 'code.file', limit: '80' }),
      pagesAbout('Pages about this repository'), mentioned,
    ],
    directory: [
      block('treemap', { title: 'Folder map', colour: 'heat', window: '90d' }),
      block('folder', { title: 'Files and folders' }), around('Around this folder'),
      block('files', { title: 'Files', colour: 'heat', window: '90d' }),
      block('related', { title: 'Around this folder', direction: 'both', limit: '40' }),
      pagesAbout('Pages about this folder'), mentioned,
    ],
    file: [block('file-page'), around('Relations'), mentioned],
    commit: [details, around('Around this commit'), block('history', { title: 'Files changed' }), around('Relations'), pagesAbout('Pages about this commit'), mentioned],
    author: [details, around('Around this author'), block('history', { title: 'Commits and files' }), around('Relations'), pagesAbout('Pages about this author'), mentioned],
  };
  for (const [name, parts] of Object.entries(layouts)) await publishFixtureTemplate(owner, product, `templates/${name}.liquid`, parts);
}
