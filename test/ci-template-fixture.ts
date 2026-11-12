/** Explicit graph layout author for the generated CI fixture, never schema preparation. */
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { publishFixtureTemplate } from './structured-template-fixture.js';
import type { TemplatePart } from '../src/knowledge/template.js';

const [product, store] = process.argv.slice(2);
if (product === undefined || store === undefined) throw new Error('usage: ci-template-fixture.ts <product> <prepared-store>');
const owner = await createDatabaseOwner({ store, connectOnly: true });
  const block = (name: Extract<TemplatePart, { type: 'block' }>['name'], params: Record<string, string> = {}): TemplatePart => ({ type: 'block', name, params, line: 1 });
  const details = block('properties', { title: 'Details', 'title-ru': 'Сведения' });
  const relations = block('relations', { title: 'Relations', 'title-ru': 'Связи' });
  const source = block('source', { title: 'Source', 'title-ru': 'Исходный текст' });
  const history = block('history', { title: 'History', 'title-ru': 'История' });
  const folder = block('folder', { title: 'Files and folders', 'title-ru': 'Файлы и папки' });
  const layouts: Record<string, readonly TemplatePart[]> = {
    file: [block('file-page')],
    directory: [details, folder, relations],
    repository: [block('treemap', { title: 'Repository map', 'title-ru': 'Карта репозитория' }), block('repository', { title: 'Repository', 'title-ru': 'Репозиторий' }), block('files', { title: 'Files', 'title-ru': 'Файлы' }), history, folder, relations],
    commit: [details, history, relations],
    author: [details, history, relations],
    database: [details, block('children', { kind: 'code.table', relation: 'code.contains', title: 'Tables', 'title-ru': 'Таблицы' }), block('er'), relations],
    table: [details, source, block('children', { kind: 'code.column', relation: 'code.has-column', title: 'Columns', 'title-ru': 'Столбцы', limit: '200' }), block('children', { kind: 'code.index', relation: 'code.has-index', title: 'Indexes', 'title-ru': 'Индексы' }), block('er'), relations],
    term: [block('term', { title: 'Definition', 'title-ru': 'Определение', field: 'definition', synonyms: 'synonyms', code: 'code' })],
    'test-quarantine': [details, source],
    'item-plain': [details, relations],
    item: [details, source, relations],
  };
  try {
    for (const [name, parts] of Object.entries(layouts)) await publishFixtureTemplate(owner, product, `templates/${name}.liquid`, parts);
  } finally { await owner.close(); }
