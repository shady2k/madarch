import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { parseDocument } from 'yaml';
import { KINDS_FILE } from './kinds.js';
import { CATALOG_GROUPS, CATALOG_KINDS, CATALOG_RELATIONS, CATALOG_SCHEMA, type CatalogGroupData, type CatalogKindData } from './starter-catalog.js';
import { STARTER_WORKFLOWS } from './starter-workflows.js';
import { BUNDLED_PLUGINS, bundledClosureHash, bundledPluginFiles, type BundledPlugin } from '../plugin/bundled.js';
import { WORKFLOWS_FILE } from './workflows.js';
import { DEFAULT_THRESHOLDS } from '../problems/types.js';
import type { RuleSpec } from '../problems/types.js';

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

/**
 * The starter set's templates (decision 0032 section 8): Liquid, one file for the
 * base page and one for each kind, and the partials they share.
 *
 * A kind template extends the base with its layout tag and fills the sections it
 * has; the base decides their order. The engine's blocks are tags; a title is
 * given in both interface languages and the reader's own is folded into `title`;
 * and the page's values are read as `{{ page.label }}` — or, as the templates of
 * 0029 wrote them, as `{{ label }}`.
 */
export const TEMPLATES: Readonly<Record<string, string>> = {
  'entity.liquid': `{% comment %}
The base page of every kind (decision 0032 section 8). A kind template extends it
with the layout tag and fills the sections it has, in this order:

  lead         what the page says first: its Markdown body, or the line that places it, and, where a kind opens with a
               picture, that picture
  details      the properties the entity holds
  around       where it stands in the graph
  source       the code it stands on
  calls        what it calls, and what calls it
  chain        the chain a reader follows from it to the tables and the topics
  parts        what it holds: history, views, modules, files, symbols, columns, tables, commits
  relations    the edges its kind declares
  describedby  the pages of this product that are about it
  mentionedon  the pages that link to it or ground a statement in it

A section a kind does not fill writes nothing. A block's title is given in both
interface languages (title and title-ru), and the wiki folds the reader's own into
title. A page's values are read as page.label, or, as the templates of 0029 wrote
them, as label.
{% endcomment %}{% block lead %}{% endblock %}
{% block details %}{% endblock %}
{% block around %}{% endblock %}
{% block source %}{% endblock %}
{% block calls %}{% endblock %}
{% block chain %}{% endblock %}
{% block parts %}{% endblock %}
{% block relations %}{% endblock %}
{% block describedby %}{% endblock %}
{% block mentionedon %}{% linkedfrom title="Mentioned on" title-ru="Упоминается на" hide-empty="true" %}{% endblock %}
`,
  'partials/around.liquid': `{% graph title=title title-ru=title_ru %}`,
  'partials/pages-about.liquid': `{% related title=title title-ru=title_ru relation="relates" %}`,
  'partials/source.liquid': `{% source title=title title-ru=title_ru %}`,
  'partials/relations.liquid': `{% related title=title title-ru=title_ru %}`,
  'partials/history.liquid': `{% history title=title title-ru=title_ru %}`,
  // The home page is read in a minute: what the product is, its system map, and the history as one line of totals and
  // the five files that change most, with the whole list of files one click away. The treemap and the relation table
  // are not on it: they live on the pages of what they describe.
  'product.liquid': `{% layout "./entity.liquid" %}
{% block lead %}{% body %}{% endblock %}
{% block parts %}{% system title="The system" title-ru="Система" %}
{% history title="Repository history" title-ru="История репозиториев" sections="summary,hotspots" limit=5 more-kind="code.file" more="All files" more-ru="Все файлы" %}{% endblock %}
`,
  'domain.liquid': `{% layout "./entity.liquid" %}
{# A domain page opens with what the domain is and how it goes: its text, the architecture of the domain and the
   chain a reader follows through it, then where it stands in the graph and what implements it. #}
{% block lead %}{% body %}{% system title="Architecture of the domain" title-ru="Архитектура домена" view="domain" %}{% sequence title="End-to-end chain" title-ru="Сквозная цепочка" scenario=page.title %}{% endblock %}
{% block around %}{% render "./partials/around.liquid", title="Around this page", title_ru="Вокруг этой страницы" %}{% endblock %}
{% block describedby %}{% related title="Implemented by" title-ru="Реализуют" relation="relates" %}{% endblock %}
`,
  'guide.liquid': `{% layout "./entity.liquid" %}
{% block lead %}# {{ page.title }}{% endblock %}
`,
  'service.liquid': `{% layout "./entity.liquid" %}
{% block lead %}{% if lang == "ru" %}{% if page.language %}Сервис на \`{{ page.language }}\`.{% endif %}{% if page.frameworks %} Фреймворки: \`{{ page.frameworks }}\`.{% endif %}{% if page.infrastructure %} Инфраструктура: \`{{ page.infrastructure }}\`.{% endif %}{% if page.testFramework %} Тесты: \`{{ page.testFramework }}\`.{% endif %}{% else %}{% if page.language %}A \`{{ page.language }}\` service.{% endif %}{% if page.frameworks %} Frameworks: \`{{ page.frameworks }}\`.{% endif %}{% if page.infrastructure %} Infrastructure: \`{{ page.infrastructure }}\`.{% endif %}{% if page.testFramework %} Tests: \`{{ page.testFramework }}\`.{% endif %}{% endif %}{% endblock %}
{% block around %}{% render "./partials/around.liquid", title="Around this service", title_ru="Вокруг этого сервиса" %}{% endblock %}
{% block parts %}{% modules title="Components and state machines" title-ru="Компоненты и конечные автоматы" %}
{% treemap title="Files by size and change" title-ru="Файлы по размеру и изменчивости" %}
{% related title="Files" title-ru="Файлы" relation="code.contains" depth=3 kind="code.file" limit=60 %}
{% related title="Modules" title-ru="Модули" relation="code.contains" depth=2 kind="code.module" limit=60 %}{% endblock %}
{% block describedby %}{% render "./partials/pages-about.liquid", title="Pages about this service", title_ru="Страницы об этом сервисе" %}{% endblock %}
`,
  'package.liquid': `{% layout "./entity.liquid" %}
{% block details %}{% properties title="Details" title-ru="Сведения" %}{% endblock %}
{% block around %}{% render "./partials/around.liquid", title="Around this", title_ru="Вокруг этого" %}{% endblock %}
{% block parts %}{% modules title="State machines" title-ru="Конечные автоматы" %}
{% related title="Modules" title-ru="Модули" relation="code.contains" direction="out" kind="code.module" limit=60 %}
{% related title="Files" title-ru="Файлы" relation="code.contains" depth=3 kind="code.file" limit=80 %}
{% related title="Relations" title-ru="Связи" relation="code.manifest-of" direction="in" %}{% endblock %}
{% block describedby %}{% render "./partials/pages-about.liquid", title="Pages about this package", title_ru="Страницы об этом пакете" %}{% endblock %}
`,
  'module.liquid': `{% layout "./entity.liquid" %}
{% block details %}{% properties title="Details" title-ru="Сведения" %}{% endblock %}
{% block around %}{% render "./partials/around.liquid", title="Around this", title_ru="Вокруг этого" %}{% endblock %}
{% block parts %}{% history title="Observed contributions" title-ru="Наблюдаемые изменения" %}
{% modules title="State machines" title-ru="Конечные автоматы" %}
{% related title="Files" title-ru="Файлы" relation="code.contains" depth=2 kind="code.file" limit=80 %}
{% related title="Symbols" title-ru="Символы" relation="code.contains" depth=3 kind="code.symbol" limit=60 %}
{% related title="Depends on" title-ru="Зависит от" relation="code.depends-on" direction="out" %}
{% related title="Depended on by" title-ru="Зависят от него" relation="code.depends-on" direction="in" %}
{% related title="Contained in" title-ru="Входит в" relation="code.contains" direction="in" %}{% endblock %}
{% block describedby %}{% render "./partials/pages-about.liquid", title="Pages about this module", title_ru="Страницы об этом модуле" %}{% endblock %}
`,
  'file.liquid': `{% layout "./entity.liquid" %}
{% block lead %}\`{{ page.path }}\`{% endblock %}
{% block details %}{% file title="Details" title-ru="Сведения" %}{% endblock %}
{% block around %}{% render "./partials/around.liquid", title="Around this file", title_ru="Вокруг этого файла" %}{% endblock %}
{% block source %}{% render "./partials/source.liquid", title="Source", title_ru="Исходный текст" %}{% endblock %}
{% block parts %}{% history title="Change history" title-ru="История изменений" %}
{% members title="What the code readers found" title-ru="Что нашли читатели кода" kind="code.facet" relation="code.facet-of" direction="in" %}
{% modules title="State machines" title-ru="Конечные автоматы" %}
{% related title="Declares" title-ru="Объявляет" relation="code.contains" direction="out" kind="code.symbol" limit=60 %}
{% related title="Imports" title-ru="Подключает" relation="code.imports" direction="out" %}
{% related title="Imported by" title-ru="Кем подключается" relation="code.imports" direction="in" %}
{% related title="Contained in" title-ru="Входит в" relation="code.contains" direction="in" %}{% endblock %}
{% block describedby %}{% render "./partials/pages-about.liquid", title="Pages about this file", title_ru="Страницы об этом файле" %}{% endblock %}
`,
  'repository.liquid': `{% layout "./entity.liquid" %}
{# The Files section: the map of the whole tree first, the table of every file below it. A reader drills the map into
   a folder and climbs back by the breadcrumb; the table finds a file by path, language and measure. Both read the
   graph alone. #}
{% block lead %}{% treemap title="Repository map" title-ru="Карта репозитория" colour="heat" window="90d" %}{% endblock %}
{% block details %}{% repository title="Repository" title-ru="Репозиторий" %}{% endblock %}
{% block parts %}{% files title="Files" title-ru="Файлы" colour="heat" window="90d" %}
{% history title="History" title-ru="История" %}
{% folder title="Root" title-ru="Корень" %}
{% related title="Files" title-ru="Файлы" relation="code.contains" depth=3 kind="code.file" limit=80 %}{% endblock %}
{% block around %}{% render "./partials/around.liquid", title="Around this repository", title_ru="Вокруг этого репозитория" %}{% endblock %}
{% block describedby %}{% render "./partials/pages-about.liquid", title="Pages about this repository", title_ru="Страницы об этом репозитории" %}{% endblock %}
`,
  'directory.liquid': `{% layout "./entity.liquid" %}
{# A folder's page is the Files section of that folder: the map of what it holds, then its files as a table. #}
{% block lead %}{% treemap title="Folder map" title-ru="Карта папки" colour="heat" window="90d" %}{% endblock %}
{% block details %}{% folder title="Files and folders" title-ru="Файлы и папки" %}{% endblock %}
{% block parts %}{% files title="Files" title-ru="Файлы" colour="heat" window="90d" %}
{% related title="Around this folder" title-ru="Вокруг этой папки" direction="both" limit=40 %}{% endblock %}
{% block around %}{% render "./partials/around.liquid", title="Around this folder", title_ru="Вокруг этой папки" %}{% endblock %}
{% block describedby %}{% render "./partials/pages-about.liquid", title="Pages about this folder", title_ru="Страницы об этой папке" %}{% endblock %}
`,
  'symbol.liquid': `{% layout "./entity.liquid" %}
{% block lead %}{% if lang == "ru" %}{% case page.symbolKind %}{% when "function" %}Функция{% when "method" %}Метод{% when "class" %}Класс{% when "interface" %}Интерфейс{% when "type" %}Тип{% when "constant" %}Константа{% when "enum" %}Перечисление{% when "struct" %}Структура{% when "variable" %}Переменная{% else %}Символ{% endcase %} в \`{{ page.path }}\`{% else %}{% if page.symbolKind %}{{ page.symbolKind }} in \`{{ page.path }}\`{% else %}\`{{ page.path }}\`{% endif %}{% endif %}{% endblock %}
{% block details %}{% properties title="Details" title-ru="Сведения" %}{% endblock %}
{% block source %}{% render "./partials/source.liquid", title="Source", title_ru="Исходный текст" %}{% endblock %}
{# A function's page reads as it did: what it calls and is called by, where it stands, the state machines of its code, then
   the chain a reader follows from it. #}
{% block calls %}{% callers title="Callers" title-ru="Кто вызывает" %}
{% callees title="Calls" title-ru="Что вызывает" %}{% endblock %}
{% block around %}{% render "./partials/around.liquid", title="Around this function", title_ru="Вокруг этой функции" %}{% endblock %}
{% block chain %}{% modules title="State machines" title-ru="Конечные автоматы" %}
{% sequence title="End-to-end chain" title-ru="Сквозная цепочка" scenario=page.label %}{% endblock %}
{% block parts %}{% members title="Fields and properties" title-ru="Поля и свойства" kind="code.field" relation="code.contains" direction="out" readers="code.reads" writers="code.writes" omit="qualifiedName" %}{% endblock %}
{% block relations %}{% related title="Tests and types" title-ru="Тесты и типы" relation="code.tests,code.implements,code.inherits" %}{% endblock %}
{% block describedby %}{% render "./partials/pages-about.liquid", title="Pages about this function", title_ru="Страницы об этой функции" %}{% endblock %}
`,
  'route.liquid': `{% layout "./entity.liquid" %}
{% block details %}{% properties title="Details" title-ru="Сведения" %}{% endblock %}
{% block around %}{% render "./partials/around.liquid", title="Around this route", title_ru="Вокруг этого маршрута" %}{% endblock %}
{% block chain %}{% sequence title="End-to-end chain" title-ru="Сквозная цепочка" scenario=page.label %}{% endblock %}
{% block source %}{% render "./partials/source.liquid", title="Source", title_ru="Исходный текст" %}{% endblock %}
{% block relations %}{% render "./partials/relations.liquid", title="Relations", title_ru="Связи" %}{% endblock %}
{% block describedby %}{% render "./partials/pages-about.liquid", title="Pages about this route", title_ru="Страницы об этом маршруте" %}{% endblock %}
`,
  'item.liquid': `{% layout "./entity.liquid" %}
{% block details %}{% properties title="Details" title-ru="Сведения" %}{% endblock %}
{% block around %}{% render "./partials/around.liquid", title="Around this", title_ru="Вокруг этого" %}{% endblock %}
{% block source %}{% render "./partials/source.liquid", title="Source", title_ru="Исходный текст" %}{% endblock %}
{% block relations %}{% render "./partials/relations.liquid", title="Relations", title_ru="Связи" %}{% endblock %}
{% block describedby %}{% render "./partials/pages-about.liquid", title="Pages about this", title_ru="Страницы об этом" %}{% endblock %}
`,
  'item-plain.liquid': `{% layout "./entity.liquid" %}
{% block details %}{% properties title="Details" title-ru="Сведения" %}{% endblock %}
{% block around %}{% render "./partials/around.liquid", title="Around this", title_ru="Вокруг этого" %}{% endblock %}
{% block relations %}{% render "./partials/relations.liquid", title="Relations", title_ru="Связи" %}{% endblock %}
{% block describedby %}{% render "./partials/pages-about.liquid", title="Pages about this", title_ru="Страницы об этом" %}{% endblock %}
`,
  'contract.liquid': `{% layout "./entity.liquid" %}
{% block details %}{% properties title="Details" title-ru="Сведения" %}
{% definition title="Definition" title-ru="Определение" %}{% endblock %}
{% block around %}{% render "./partials/around.liquid", title="Around this contract", title_ru="Вокруг этого контракта" %}{% endblock %}
{% block source %}{% render "./partials/source.liquid", title="Source", title_ru="Исходный текст" %}{% endblock %}
{% block relations %}{% render "./partials/relations.liquid", title="Relations", title_ru="Связи" %}{% endblock %}
{% block describedby %}{% render "./partials/pages-about.liquid", title="Pages about this contract", title_ru="Страницы об этом контракте" %}{% endblock %}
`,
  'operation.liquid': `{% layout "./entity.liquid" %}
{% block details %}{% properties title="Details" title-ru="Сведения" %}
{% definition title="Definition" title-ru="Определение" %}{% endblock %}
{% block around %}{% render "./partials/around.liquid", title="Around this operation", title_ru="Вокруг этой операции" %}{% endblock %}
{% block chain %}{% sequence title="End-to-end chain" title-ru="Сквозная цепочка" scenario=page.label %}{% endblock %}
{% block source %}{% render "./partials/source.liquid", title="Source", title_ru="Исходный текст" %}{% endblock %}
{% block parts %}{% related title="Declared by" title-ru="Объявлена в" relation="code.declares" direction="in" %}
{% related title="Served by" title-ru="Обслуживается" relation="code.serves" direction="in" %}{% endblock %}
{% block relations %}{% render "./partials/relations.liquid", title="Relations", title_ru="Связи" %}{% endblock %}
{% block describedby %}{% render "./partials/pages-about.liquid", title="Pages about this operation", title_ru="Страницы об этой операции" %}{% endblock %}
`,
  'history-task.liquid': `{% layout "./entity.liquid" %}
{% block details %}{% properties title="Details" title-ru="Сведения" %}{% endblock %}
{% block parts %}{% render "./partials/history.liquid", title="Commits", title_ru="Коммиты" %}{% endblock %}
{% block around %}{% render "./partials/around.liquid", title="Around this", title_ru="Вокруг этого" %}{% endblock %}
{% block relations %}{% render "./partials/relations.liquid", title="Relations", title_ru="Связи" %}{% endblock %}
{% block describedby %}{% render "./partials/pages-about.liquid", title="Pages about this task", title_ru="Страницы об этой задаче" %}{% endblock %}
`,
  'commit.liquid': `{% layout "./entity.liquid" %}
{% block details %}{% properties title="Details" title-ru="Сведения" %}{% endblock %}
{% block parts %}{% render "./partials/history.liquid", title="Files changed", title_ru="Изменённые файлы" %}{% endblock %}
{% block around %}{% render "./partials/around.liquid", title="Around this commit", title_ru="Вокруг этого коммита" %}{% endblock %}
{% block relations %}{% render "./partials/relations.liquid", title="Relations", title_ru="Связи" %}{% endblock %}
{% block describedby %}{% render "./partials/pages-about.liquid", title="Pages about this commit", title_ru="Страницы об этом коммите" %}{% endblock %}
`,
  'author.liquid': `{% layout "./entity.liquid" %}
{% block details %}{% properties title="Details" title-ru="Сведения" %}{% endblock %}
{% block parts %}{% render "./partials/history.liquid", title="Commits and files", title_ru="Коммиты и файлы" %}{% endblock %}
{% block around %}{% render "./partials/around.liquid", title="Around this author", title_ru="Вокруг этого автора" %}{% endblock %}
{% block relations %}{% render "./partials/relations.liquid", title="Relations", title_ru="Связи" %}{% endblock %}
{% block describedby %}{% render "./partials/pages-about.liquid", title="Pages about this author", title_ru="Страницы об этом авторе" %}{% endblock %}
`,
  'database.liquid': `{% layout "./entity.liquid" %}
{% block details %}{% properties title="Details" title-ru="Сведения" %}{% endblock %}
{% block around %}{% render "./partials/around.liquid", title="Around this", title_ru="Вокруг этого" %}{% endblock %}
{% block parts %}{% assign tables_prefix = "code.table:" | append: page.label | append: "/" %}
{% children title="Tables" title-ru="Таблицы" kind="code.table" prefix=tables_prefix relation="code.contains" %}
{% assign migrations_prefix = "code.migration:" | append: page.label | append: "/" %}
{% children title="Migrations" title-ru="Миграции" kind="code.migration" prefix=migrations_prefix relation="code.contains" %}
{% er title="Tables and their links" title-ru="Таблицы и связи между ними" limit=12 %}{% endblock %}
{% block relations %}{% render "./partials/relations.liquid", title="Relations", title_ru="Связи" %}{% endblock %}
{% block describedby %}{% render "./partials/pages-about.liquid", title="Pages about this database", title_ru="Страницы об этой базе данных" %}{% endblock %}
`,
  'table.liquid': `{% layout "./entity.liquid" %}
{% block details %}{% properties title="Details" title-ru="Сведения" %}{% endblock %}
{% block around %}{% render "./partials/around.liquid", title="Around this", title_ru="Вокруг этого" %}{% endblock %}
{% block source %}{% render "./partials/source.liquid", title="Source", title_ru="Исходный текст" %}{% endblock %}
{% block parts %}{% assign columns_prefix = page.key | append: "/" %}
{% children title="Columns" title-ru="Столбцы" kind="code.column" prefix=columns_prefix relation="code.contains" limit=200 %}
{% assign indexes_prefix = "code.index:" | append: page.keyrest | append: "/" %}
{% children title="Indexes" title-ru="Индексы" kind="code.index" prefix=indexes_prefix relation="code.contains" %}
{% er title="The table and its links" title-ru="Таблица и её связи" %}{% endblock %}
{% block relations %}{% render "./partials/relations.liquid", title="Relations", title_ru="Связи" %}{% endblock %}
{% block describedby %}{% render "./partials/pages-about.liquid", title="Pages about this table", title_ru="Страницы об этой таблице" %}{% endblock %}
`,
  'entity-text.liquid': `{% layout "./entity.liquid" %}
{% block lead %}{% body %}{% endblock %}
{% block relations %}{% stated title="Stated in" title-ru="Где описано" %}
{% implementedby title="Implemented by" title-ru="Чем реализовано" %}{% endblock %}
`,
  'enrichment.liquid': `{% layout "./entity.liquid" %}
{% block lead %}{% body %}{% endblock %}
{% block chain %}{% sequence title="End-to-end chain" title-ru="Сквозная цепочка" scenario=page.title %}{% endblock %}
{% block relations %}{% render "./partials/relations.liquid", title="Relations", title_ru="Связи" %}{% endblock %}
{% block describedby %}{% render "./partials/pages-about.liquid", title="Pages about this", title_ru="Страницы об этом" %}{% endblock %}
`,
  'term.liquid': `{% layout "./entity.liquid" %}
{% block lead %}{% term title="Definition" title-ru="Определение" field="definition" synonyms="synonyms" code="code" %}{% endblock %}
`,
  'question.liquid': `{% layout "./entity.liquid" %}
{% block lead %}{% body %}{% endblock %}
`,
  'correction.liquid': `{% layout "./entity.liquid" %}
{% block lead %}{% body %}{% endblock %}
`,
  'task.liquid': `{% layout "./entity.liquid" %}
{% block lead %}{% body %}{% endblock %}
`,
};

/** One kind of the starter catalog whose entities the wiki shows: a page of its own, or a member's row. */
export type StarterKind = CatalogKindData & {
  readonly template: keyof typeof TEMPLATES;
  readonly source: 'markdown' | 'graph' | 'document';
  /** `one` and `many` per language. */
  readonly en: readonly [string, string];
  readonly ru: readonly [string, string];
  readonly describe: readonly [string, string];
};

/**
 * The kinds of the starter set the wiki shows, in the manifest's order: the catalog hods every kind of the product's
 * life cycle, and a kind the engine cannot make yet (the template policy `none`) shows no page, so it is no kind here.
 */
export const STARTER_KINDS: readonly StarterKind[] = CATALOG_KINDS.filter(
  (kind): kind is StarterKind => kind.policy !== 'none' && kind.template !== undefined && kind.source !== undefined && kind.en !== undefined && kind.ru !== undefined && kind.describe !== undefined,
);

/**
 * The groups of the navigation and the catalogue, as the catalog declares them: an area, then its subgroups. The
 * engine holds none of them; the product's manifest names every one.
 */
export const GROUPS: readonly CatalogGroupData[] = CATALOG_GROUPS;

/** What each role opens on a page and puts first in the navigation (decision 0031); the product edits them. */
export const ROLES: readonly { name: string; lead: string[]; open: string[] }[] = [
  { name: 'product', lead: ['strategy', 'discovery', 'requirements', 'rd'], open: ['stated', 'implementedby', 'linkedfrom', 'related', 'properties'] },
  { name: 'analyst', lead: ['strategy', 'requirements', 'data', 'contracts', 'information'], open: ['stated', 'implementedby', 'linkedfrom', 'related', 'properties', 'er', 'sequence', 'children'] },
  { name: 'architect', lead: ['architecture', 'code', 'contracts', 'data', 'infrastructure', 'security', 'common'], open: ['graph', 'related', 'sequence', 'er', 'stated', 'implementedby', 'linkedfrom', 'properties', 'children'] },
  { name: 'developer', lead: ['code', 'contracts', 'data', 'testing', 'delivery', 'review', 'history', 'work'], open: ['source', 'callers', 'callees', 'sequence', 'graph', 'related', 'history', 'properties', 'children', 'er', 'stated'] },
  { name: 'operations', lead: ['operations', 'infrastructure', 'messaging', 'resilience'], open: ['properties', 'related', 'history', 'children', 'source', 'er', 'stated'] },
  { name: 'tester', lead: ['testing', 'requirements', 'strategy'], open: ['stated', 'implementedby', 'linkedfrom', 'related', 'properties', 'callers', 'children'] },
  { name: 'designer', lead: ['design', 'requirements', 'discovery'], open: ['stated', 'implementedby', 'linkedfrom', 'related', 'properties', 'children'] },
  { name: 'security-engineer', lead: ['security', 'privacy', 'architecture', 'delivery'], open: ['properties', 'related', 'graph', 'children', 'source', 'stated'] },
  { name: 'platform-devops', lead: ['infrastructure', 'delivery', 'operations', 'messaging', 'automation', 'decommissioning'], open: ['properties', 'related', 'history', 'children', 'source', 'er', 'stated'] },
  { name: 'product-lead', lead: ['strategy', 'costs', 'suppliers', 'documentation', 'organisation', 'ml', 'work', 'common'], open: ['stated', 'implementedby', 'linkedfrom', 'related', 'properties'] },
];

/**
 * A property's declaration as the starter set writes it: the words a reader sees in each language, how the value is
 * written, and, for a value that is an object, the keys it holds and their labels (a build's context, its Dockerfile).
 */
interface PropertyLabel {
  en: string;
  ru: string;
  format?: string;
  fields?: Readonly<Record<string, { en: string; ru: string; format?: string }>>;
}

const PROPERTY_LABELS: Readonly<Record<string, PropertyLabel>> = {
  language: { en: "Language", ru: "Язык", format: "text" },
  frameworks: { en: "Frameworks", ru: "Фреймворки", format: "list" },
  infrastructure: { en: "Infrastructure", ru: "Инфраструктура", format: "list" },
  testFramework: { en: "Test framework", ru: "Тестовый фреймворк", format: "text" },
  ecosystem: { en: "Ecosystem", ru: "Экосистема", format: "text" },
  name: { en: "Name", ru: "Имя", format: "text" },
  version: { en: "Version", ru: "Версия", format: "text" },
  external: { en: "External", ru: "Внешняя", format: "boolean" },
  hasTests: { en: "Has tests", ru: "Есть тесты", format: "boolean" },
  sourceFiles: { en: "Source files", ru: "Исходные файлы", format: "number" },
  testFiles: { en: "Test files", ru: "Тестовые файлы", format: "number" },
  tests: { en: "Tests", ru: "Тесты", format: "list" },
  versionStatus: { en: "Version status", ru: "Состояние версии", format: "text" },
  standardLibrary: { en: "Standard library", ru: "Стандартная библиотека", format: "boolean" },
  role: { en: "Role", ru: "Роль", format: "text" },
  kind: { en: "Kind", ru: "Вид", format: "text" },
  files: { en: "Files", ru: "Файлы", format: "number" },
  parsedFiles: { en: "Parsed files", ru: "Разобранные файлы", format: "number" },
  packageName: { en: "Package name", ru: "Имя пакета", format: "text" },
  symbolKind: { en: "Symbol kind", ru: "Вид символа", format: "text" },
  qualifiedName: { en: "Qualified name", ru: "Полное имя", format: "text" },
  typeText: { en: "Type", ru: "Тип", format: "text" },
  value: { en: "Value", ru: "Значение", format: "code" },
  exported: { en: "Exported", ru: "Экспортируется", format: "boolean" },
  abstract: { en: "Abstract", ru: "Абстрактный", format: "boolean" },
  inline: { en: "Inline", ru: "Встроенный", format: "boolean" },
  test: { en: "Test", ru: "Тест", format: "commands" },
  deadExport: { en: "Unused export", ru: "Неиспользуемый экспорт", format: "boolean" },
  entryPoint: { en: "Entry point", ru: "Точка входа", format: "text" },
  entryPoints: { en: "Entry points", ru: "Точки входа", format: "list" },
  file: { en: "File", ru: "Файл", format: "path" },
  service: { en: "Service", ru: "Сервис", format: "text" },
  symbol: { en: "Symbol", ru: "Символ", format: "text" },
  starts: { en: "Starts", ru: "Запускает", format: "list" },
  level: { en: "Level", ru: "Уровень", format: "text" },
  size: { en: "Size", ru: "Размер", format: "number" },
  marker: { en: "Marker", ru: "Маркер", format: "text" },
  text: { en: "Text", ru: "Текст", format: "text" },
  path: { en: "Path", ru: "Путь", format: "path" },
  line: { en: "Line", ru: "Строка", format: "number" },
  lines: { en: "Lines", ru: "Строк", format: "number" },
  mode: { en: "Mode", ru: "Режим", format: "text" },
  blob: { en: "Blob", ru: "Blob", format: "code" },
  bytes: { en: "Bytes", ru: "Байт", format: "number" },
  form: { en: "Form", ru: "Форма", format: "text" },
  candidates: { en: "Languages", ru: "Языки", format: "list" },
  author: { en: "Author", ru: "Автор", format: "text" },
  authorEmail: { en: "Author email", ru: "Почта автора", format: "text" },
  source: { en: "Source", ru: "Источник", format: "text" },
  readBy: { en: "Read by", ru: "Читает", format: "text" },
  function: { en: "Function", ru: "Функция", format: "text" },
  callee: { en: "Callee", ru: "Вызываемый", format: "text" },
  method: { en: "Method", ru: "Метод", format: "text" },
  authGroup: { en: "Authentication group", ru: "Группа авторизации", format: "boolean" },
  authAlgorithm: { en: "Authentication algorithm", ru: "Алгоритм авторизации", format: "text" },
  handler: { en: "Handler", ru: "Обработчик", format: "text" },
  handlerPath: { en: "Handler file", ru: "Файл обработчика", format: "path" },
  operationId: { en: "Operation id", ru: "Идентификатор операции", format: "text" },
  public: { en: "Public", ru: "Публичная", format: "boolean" },
  package: { en: "Package", ru: "Пакет", format: "text" },
  input: { en: "Input", ru: "Входные данные", format: "text" },
  output: { en: "Output", ru: "Результат", format: "text" },
  rpc: { en: "RPC", ru: "RPC", format: "text" },
  servers: { en: "Servers", ru: "Серверы", format: "list" },
  summary: { en: "Summary", ru: "Кратко", format: "text" },
  format: { en: "Format", ru: "Формат", format: "text" },
  specVersion: { en: "Specification version", ru: "Версия спецификации", format: "text" },
  protocol: { en: "Protocol", ru: "Протокол", format: "text" },
  contract: { en: "Contract", ru: "Контракт", format: "text" },
  description: { en: "Description", ru: "Описание", format: "text" },
  consumerStatus: { en: "Consumer status", ru: "Состояние потребителя", format: "text" },
  consumerFound: { en: "Consumer found", ru: "Потребитель найден", format: "boolean" },
  channel: { en: "Channel", ru: "Канал", format: "text" },
  eventTypes: { en: "Event types", ru: "Типы событий", format: "list" },
  database: { en: "Database", ru: "База данных", format: "text" },
  schema: { en: "Schema", ru: "Схема", format: "text" },
  evidenceKind: { en: "Evidence", ru: "Основание", format: "text" },
  type: { en: "Type", ru: "Тип", format: "text" },
  nullable: { en: "Nullable", ru: "Допускает NULL", format: "boolean" },
  default: { en: "Default", ru: "Значение по умолчанию", format: "code" },
  primaryKey: { en: "Primary key", ru: "Первичный ключ", format: "boolean" },
  unique: { en: "Unique", ru: "Уникальный", format: "boolean" },
  check: { en: "Check", ru: "Проверка", format: "code" },
  columns: { en: "Columns", ru: "Столбцы", format: "list" },
  where: { en: "Condition", ru: "Условие", format: "code" },
  ordinal: { en: "Order", ru: "Порядок", format: "number" },
  required: { en: "Required", ru: "Обязательна", format: "boolean" },
  scope: { en: "Scope", ru: "Область", format: "text" },
  exact: { en: "Exact version", ru: "Точная версия", format: "boolean" },
  module: { en: "Module", ru: "Модуль", format: "text" },
  goVersion: { en: "Go version", ru: "Версия Go", format: "text" },
  private: { en: "Private", ru: "Приватный", format: "boolean" },
  scripts: { en: "Scripts", ru: "Сценарии", format: "scripts" },
  lockfileVersion: { en: "Lock file version", ru: "Версия файла блокировки", format: "number" },
  modules: { en: "Modules", ru: "Модули", format: "number" },
  packages: { en: "Packages", ru: "Пакеты", format: "number" },
  devOnlyPackages: { en: "Development packages", ru: "Пакеты для разработки", format: "number" },
  baseImages: { en: "Base images", ru: "Базовые образы", format: "list" },
  exposes: { en: "Exposes", ru: "Открывает порты", format: "list" },
  command: { en: "Command", ru: "Команда", format: "commands" },
  repository: { en: "Repository", ru: "Репозиторий", format: "text" },
  tag: { en: "Tag", ru: "Тег", format: "text" },
  image: { en: "Image", ru: "Образ", format: "text" },
  build: {
    en: "Build", ru: "Сборка", format: "build",
    // The keys a compose build holds. The engine reads them because the manifest names them, not because it knows a product.
    fields: { context: { en: "Build context", ru: "Контекст сборки", format: "path" }, dockerfile: { en: "Dockerfile", ru: "Dockerfile", format: "path" } },
  },
  ports: { en: "Ports", ru: "Порты", format: "ports" },
  dependsOn: { en: "Depends on", ru: "Зависит от", format: "list" },
  environment: { en: "Environment", ru: "Окружение", format: "list" },
  containerPorts: { en: "Container ports", ru: "Порты контейнера", format: "list" },
  envFrom: { en: "Environment from", ru: "Окружение из", format: "list" },
  replicas: { en: "Replicas", ru: "Реплики", format: "number" },
  probePath: { en: "Probe path", ru: "Путь проверки", format: "text" },
  probePaths: { en: "Probe paths", ru: "Пути проверки", format: "list" },
  on: { en: "On", ru: "События", format: "list" },
  workingDirectory: { en: "Working directory", ru: "Рабочая папка", format: "path" },
  steps: { en: "Steps", ru: "Шаги", format: "commands" },
  uses: { en: "Uses", ru: "Использует", format: "list" },
  phony: { en: "Phony", ru: "Фиктивная цель", format: "boolean" },
  recipe: { en: "Recipe", ru: "Рецепт", format: "commands" },
  binary: { en: "Binary", ru: "Программа", format: "text" },
  port: { en: "Port", ru: "Порт", format: "number" },
  statusOk: { en: "Healthy on success", ru: "Успех означает здоровье", format: "boolean" },
  metricType: { en: "Metric type", ru: "Тип метрики", format: "text" },
  help: { en: "Help", ru: "Описание", format: "text" },
  labels: { en: "Labels", ru: "Метки", format: "list" },
  library: { en: "Library", ru: "Библиотека", format: "text" },
  definitionFormat: { en: "Definition format", ru: "Формат описания", format: "text" },
  technology: { en: "Technology", ru: "Технология", format: "text" },
  addresses: { en: "Addresses", ru: "Адреса", format: "list" },
  probeType: { en: "Probe type", ru: "Тип пробы", format: "text" },
  container: { en: "Container", ru: "Контейнер", format: "text" },
  resolvedPort: { en: "Resolved port", ru: "Найденный порт", format: "number" },
  scheme: { en: "Scheme", ru: "Схема", format: "text" },
  host: { en: "Host", ru: "Хост", format: "text" },
  initialDelaySeconds: { en: "Initial delay", ru: "Начальная задержка", format: "text" },
  periodSeconds: { en: "Period", ru: "Период", format: "text" },
  timeoutSeconds: { en: "Timeout", ru: "Таймаут", format: "text" },
  successThreshold: { en: "Success threshold", ru: "Порог успеха", format: "number" },
  failureThreshold: { en: "Failure threshold", ru: "Порог отказа", format: "number" },
  terminationGracePeriodSeconds: { en: "Termination grace", ru: "Время на остановку", format: "text" },
  transport: { en: "Transport", ru: "Транспорт", format: "text" },
  interval: { en: "Interval", ru: "Интервал", format: "text" },
  retries: { en: "Retries", ru: "Повторы", format: "number" },
  disable: { en: "Disabled", ru: "Отключена", format: "boolean" },
  startPeriod: { en: "Start period", ru: "Период запуска", format: "text" },
  startInterval: { en: "Start interval", ru: "Интервал запуска", format: "text" },
  heading: { en: "Heading", ru: "Заголовок", format: "text" },
  folder: { en: "Folder", ru: "Папка", format: "path" },
  purpose: { en: "Purpose", ru: "Назначение", format: "text" },
  order: { en: "Order", ru: "Порядок", format: "number" },
  tools: { en: "Tools", ru: "Инструменты", format: "list" },
  symptom: { en: "Symptom", ru: "Симптом", format: "text" },
  fix: { en: "Fix", ru: "Исправление", format: "text" },
  testKind: { en: "Test kind", ru: "Вид теста", format: "text" },
  skipped: { en: "Skipped", ru: "Пропущен", format: "boolean" },
  skipReason: { en: "Skip reason", ru: "Причина пропуска", format: "text" },
  cases: { en: "Cases", ru: "Случаи", format: "number" },
  suite: { en: "Suite", ru: "Набор", format: "list" },
  subject: { en: "Subject", ru: "Тема", format: "text" },
  authoredAt: { en: "Authored", ru: "Создан", format: "date" },
  committedAt: { en: "Committed", ru: "Зафиксирован", format: "date" },
  merge: { en: "Merge commit", ru: "Коммит слияния", format: "boolean" },
  mergedBranch: { en: "Merged branch", ru: "Слитая ветка", format: "text" },
  commit: { en: "Commit", ru: "Коммит", format: "text" },
  commitCount: { en: "Commits", ru: "Коммитов", format: "number" },
  authors: { en: "Authors", ru: "Авторы", format: "list" },
  parsed: { en: "Parsed", ru: "Разобран", format: "boolean" },
  identifier: { en: "Identifier", ru: "Идентификатор", format: "text" },
  document: { en: "Document", ru: "Документ", format: "path" },
  framework: { en: "Framework", ru: "Фреймворк", format: "text" },
  json: { en: "JSON logs", ru: "Журнал JSON", format: "boolean" },
  middleware: { en: "Middleware", ru: "Промежуточные обработчики", format: "list" },
  model: { en: "Model", ru: "Модель", format: "text" },
  timeout: { en: "Timeout", ru: "Таймаут", format: "text" },
};

/** The properties each kind shows on its page, in the order a reader meets them (madarch-m38l.21). */
export const DETAILS: Readonly<Record<string, readonly string[]>> = {
  "code.service": ["language", "frameworks", "infrastructure", "testFramework"],
  "code.package": ["ecosystem", "name", "version", "external", "frameworks", "hasTests", "sourceFiles", "testFiles", "tests", "versionStatus", "standardLibrary"],
  "code.module": ["role", "kind", "language", "files", "parsedFiles", "packageName"],
  "code.symbol": ["symbolKind", "qualifiedName", "typeText", "language", "exported", "abstract", "inline", "test", "deadExport", "entryPoint", "entryPoints"],
  "code.field": ["symbolKind", "qualifiedName", "typeText", "value", "language"],
  "code.entry-point": ["file", "language", "service", "symbol", "starts"],
  "code.cycle": ["level", "size"],
  "code.debt": ["marker", "text", "path", "line"],
  "code.directory": ["path"],
  "code.file": ["mode", "blob", "bytes", "lines", "form", "language", "candidates", "commitCount", "authors"],
  "code.facet": ["language", "role", "authors", "commitCount", "parsed"],
  "code.input": ["name", "source"],
  "code.sql-build": [],
  "code.sql-sink": [],
  "code.route": ["method", "path", "authGroup", "authAlgorithm", "handler", "handlerPath", "service", "middleware", "ports"],
  "code.operation": ["method", "path", "operationId", "public", "service", "package", "input", "output", "rpc", "servers", "summary"],
  "code.contract": ["format", "specVersion", "version", "path"],
  "code.channel": ["protocol", "contract", "path", "description", "consumerStatus", "consumerFound"],
  "code.message": ["channel", "eventTypes", "path"],
  "code.database": ["service", "path", "evidenceKind"],
  "code.table": ["database", "schema"],
  "code.column": ["type", "nullable", "default", "primaryKey", "unique", "check"],
  "code.index": ["columns", "unique", "where"],
  "code.migration": ["ordinal", "path"],
  "code.env-var": ["required", "default"],
  "code.env-definition": ["scope"],
  "code.dependency": ["name", "version", "scope", "exact"],
  "code.manifest": ["ecosystem", "name", "version", "module", "goVersion", "private"],
  "code.lockfile": ["format", "lockfileVersion", "modules", "packages", "devOnlyPackages"],
  "code.dockerfile": ["baseImages", "exposes", "command"],
  "code.image": ["repository", "tag"],
  "code.compose-service": ["image", "ports", "dependsOn", "environment"],
  "code.k8s-deployment": ["image", "replicas", "containerPorts", "probePath", "probePaths", "envFrom"],
  "code.k8s-service": ["ports"],
  "code.ci-workflow": ["name", "on"],
  "code.ci-job": ["workingDirectory", "steps", "uses"],
  "code.make-target": ["phony", "recipe"],
  "code.process": ["binary", "command"],
  "code.port": ["port", "service"],
  "code.health-endpoint": ["method", "path", "ports", "statusOk", "service"],
  "code.metric": ["name", "metricType", "help", "labels", "library", "definitionFormat", "service"],
  "code.broker": ["technology", "source", "addresses"],
  "code.probe": ["probeType", "container", "path", "port", "resolvedPort", "scheme", "host", "initialDelaySeconds", "periodSeconds", "timeoutSeconds", "successThreshold", "failureThreshold", "terminationGracePeriodSeconds", "transport"],
  "code.healthcheck": ["service", "test", "interval", "timeout", "retries", "disable", "startPeriod", "startInterval"],
  "code.document-section": ["heading", "level", "path"],
  "code.metrics-endpoint": ["method", "path", "ports", "format", "library", "service"],
  "code.logger": ["library", "model", "service", "json"],
  "code.newcomer-command": ["command", "folder", "purpose", "order"],
  "code.newcomer-prerequisites": ["tools"],
  "code.newcomer-failure": ["symptom", "command", "fix", "port"],
  "code.test-case": ["name", "testKind", "framework", "language", "path", "skipped", "skipReason", "cases", "suite"],
  "code.commit": ["author", "authorEmail", "subject", "authoredAt", "committedAt", "merge", "mergedBranch"],
  "code.snapshot": ["commit"],
};

const yamlText = (text: string): string => JSON.stringify(text);

/** One property of `PROPERTY_LABELS` as the manifest's flow mapping, its value's keys included. */
function propertyYaml(label: PropertyLabel): string {
  const fields = label.fields === undefined ? '' : `, fields: { ${Object.entries(label.fields).map(([key, field]) => `${key}: ${propertyYaml(field)}`).join(', ')} }`;
  return `{ en: ${yamlText(label.en)}, ru: ${yamlText(label.ru)}, format: ${yamlText(label.format ?? 'text')}${fields} }`;
}

/** One property's declaration as the manifest's YAML nodes: what an upgrade adds when a kind needs a property it names. */
export function propertyDeclaration(name: string): Record<string, unknown> | undefined {
  const label = PROPERTY_LABELS[name];
  if (label === undefined) return undefined;
  const fields = label.fields === undefined ? {} : Object.fromEntries(Object.entries(label.fields).map(([key, field]) => [key, { en: field.en, ru: field.ru, format: field.format ?? 'text' }]));
  return { en: label.en, ru: label.ru, format: label.format ?? 'text', ...(label.fields === undefined ? {} : { fields }) };
}

/** The exclusion list of the manifest's `documents` section. */
export const DOCUMENT_EXCLUDES: readonly string[] = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '**/AGENTS.md', '**/CLAUDE.md', '**/GEMINI.md'];

/**
 * The rules of the Problems page as the starter manifest writes them (madarch-m38l.19, the review's
 * first finding): this is starter content, not engine behaviour. The engine keeps only the
 * predicates these rules name; a product edits, disables or adds a rule in its own manifest.
 */
export const STARTER_PROBLEM_RULES: readonly RuleSpec[] = [
  { id: 'dependency.cycle', predicate: 'dependency-cycle', kind: 'dependency-cycle', sonar: 'bug', severity: 'major', section: 'code', action: 'task', enabled: true, label: { en: 'Dependency cycle', ru: 'Цикл зависимостей' } },
  { id: 'security.sql-input', predicate: 'sql-input', kind: 'sql-input', sonar: 'vulnerability', severity: 'blocker', section: 'code', action: 'task', enabled: true, label: { en: 'Untrusted input reaches SQL', ru: 'Внешние данные попадают в SQL' } },
  { id: 'security.export-route', predicate: 'route-outside-auth', kind: 'route-outside-auth', sonar: 'vulnerability', severity: 'critical', section: 'code', action: 'task', enabled: true, label: { en: 'Route outside the auth group', ru: 'Маршрут вне группы авторизации' } },
  { id: 'large-file', predicate: 'large-file', kind: 'large-file', sonar: 'code-smell', severity: 'minor', section: 'code', action: 'task', enabled: true, label: { en: 'Large file', ru: 'Большой файл' } },
  { id: 'hotspot', predicate: 'change-hotspot', kind: 'change-hotspot', sonar: 'code-smell', severity: 'major', section: 'code', action: 'task', enabled: true, label: { en: 'Change hotspot', ru: 'Горячая точка изменений' } },
  { id: 'dead-export', predicate: 'dead-export', kind: 'dead-export', sonar: 'code-smell', severity: 'minor', section: 'code', action: 'task', enabled: true, label: { en: 'Exported but unused', ru: 'Экспорт без использования' } },
  { id: 'debt.todo', predicate: 'debt', kind: 'debt-todo', sonar: 'code-smell', severity: 'info', section: 'code', action: 'task', enabled: true, params: { marker: 'TODO' }, label: { en: 'TODO', ru: 'TODO' } },
  { id: 'debt.fixme', predicate: 'debt', kind: 'debt-fixme', sonar: 'code-smell', severity: 'minor', section: 'code', action: 'task', enabled: true, params: { marker: 'FIXME' }, label: { en: 'FIXME', ru: 'FIXME' } },
  { id: 'config.required-dev-value', predicate: 'config-development-value', kind: 'config-development-value', sonar: 'vulnerability', severity: 'critical', section: 'code', action: 'task', enabled: true, params: { secrets: [], developmentValues: [] }, label: { en: 'Required setting has a checked-in value', ru: 'Обязательная настройка задана в репозитории' } },
  { id: 'dependency.declared-unused', predicate: 'dependency-declared-unused', kind: 'dependency-declared-unused', sonar: 'code-smell', severity: 'minor', section: 'code', action: 'task', enabled: true, label: { en: 'Dependency declared but unused', ru: 'Зависимость объявлена, но не используется' } },
  { id: 'dependency.used-undeclared', predicate: 'dependency-used-undeclared', kind: 'dependency-used-undeclared', sonar: 'bug', severity: 'major', section: 'code', action: 'task', enabled: true, label: { en: 'Dependency used but undeclared', ru: 'Зависимость используется, но не объявлена' } },
  { id: 'contract.operation-without-route', predicate: 'operation-without-route', kind: 'operation-without-route', sonar: 'bug', severity: 'major', section: 'code', action: 'task', enabled: true, label: { en: 'Contract operation is not implemented', ru: 'Операция контракта не реализована' } },
  { id: 'contract.route-without-operation', predicate: 'route-without-operation', kind: 'route-without-operation', sonar: 'bug', severity: 'minor', section: 'code', action: 'task', enabled: true, label: { en: 'Route is not in the contract', ru: 'Маршрута нет в контракте' } },

  { id: 'document.contradiction', predicate: 'document-contradiction', kind: 'document-contradiction', sonar: 'bug', severity: 'major', section: 'documents', action: 'task', enabled: true, label: { en: 'Contradiction', ru: 'Противоречие' } },
  { id: 'document.stale', predicate: 'document-stale', kind: 'document-stale', sonar: 'bug', severity: 'major', section: 'documents', action: 'task', enabled: true, label: { en: 'Stale statement', ru: 'Устаревшее утверждение' } },
  { id: 'document.undocumented', predicate: 'document-undocumented', kind: 'document-undocumented', sonar: 'code-smell', severity: 'major', section: 'documents', action: 'task', enabled: true, label: { en: 'Undocumented behaviour', ru: 'Неописанное поведение' } },
  { id: 'document.ambiguous-term', predicate: 'document-ambiguous', kind: 'document-ambiguous', sonar: 'code-smell', severity: 'minor', section: 'documents', action: 'task', enabled: true, label: { en: 'Ambiguous term', ru: 'Неоднозначный термин' } },

  { id: 'wiki.correction', predicate: 'wiki', kind: 'correction', sonar: 'bug', severity: 'major', section: 'wiki', action: 'task', enabled: true, label: { en: 'Correction', ru: 'Исправление' } },
  { id: 'wiki.ground-removed', predicate: 'wiki', kind: 'ground-removed', sonar: 'bug', severity: 'major', section: 'wiki', action: 'task', enabled: true, label: { en: 'Ground removed', ru: 'Основание исчезло' } },
  { id: 'wiki.broken-link', predicate: 'wiki', kind: 'broken-link', sonar: 'bug', severity: 'major', section: 'wiki', action: 'task', enabled: true, label: { en: 'Broken link', ru: 'Ссылка никуда не ведёт' } },
  { id: 'wiki.unreadable-file', predicate: 'wiki', kind: 'unreadable-file', sonar: 'bug', severity: 'major', section: 'wiki', action: 'task', enabled: true, label: { en: 'Unreadable file', ru: 'Файл не читается' } },
  { id: 'wiki.unplaced', predicate: 'wiki', kind: 'unplaced', sonar: 'code-smell', severity: 'minor', section: 'wiki', action: 'task', enabled: true, label: { en: 'Unplaced finding', ru: 'Находка без места' } },
  { id: 'wiki.manifest', predicate: 'wiki', kind: 'manifest', sonar: 'bug', severity: 'major', section: 'wiki', action: 'task', enabled: true, label: { en: 'Manifest finding', ru: 'Замечание к манифесту' } },
];


/** One rule as a flow mapping of the manifest; `JSON.stringify` quotes every string, the labels included. */
function ruleYaml(rule: RuleSpec): string {
  const fields: string[] = [
    `predicate: ${rule.predicate}`,
    `kind: ${rule.kind}`,
    `sonar: ${rule.sonar}`,
    `severity: ${rule.severity}`,
    `section: ${rule.section}`,
    `action: ${rule.action}`,
    `enabled: ${rule.enabled === false ? 'false' : 'true'}`,
  ];
  if (rule.params !== undefined) {
    const params = Object.entries(rule.params).map(([name, value]) => {
      if (Array.isArray(value)) return `${name}: [${value.map((entry) => yamlText(String(entry))).join(', ')}]`;
      if (typeof value === 'string') return `${name}: ${yamlText(value)}`;
      return `${name}: ${String(value)}`;
    });
    fields.push(`params: { ${params.join(', ')} }`);
  }
  fields.push(`label: { en: ${yamlText(rule.label.en)}, ru: ${yamlText(rule.label.ru)} }`);
  return `{ ${fields.join(', ')} }`;
}

/**
 * The `madarch/workflows.yaml` the starter set writes (decision 0033, items 1 and 2):
 * the four workflows over the engine's stage ids, in code point order of their names,
 * with the comment block that explains the file to a person editing it.
 */
function workflowsManifest(): string {
  const lines: string[] = [
    "# The workflows this product runs (decision 0033, items 1 and 2). A workflow is a named set of the engine's stage",
    "# ids; the stages' capabilities give the order, so no edge is declared here. A workflow's status says what the",
    "# engine can do with it today:",
    "#   implemented  every stage it names is one the engine's stage registry holds, and every required input of those",
    "#                stages is produced by another stage of the workflow",
    "#   planned      the engine has no stage for it yet: it may name no stages, and a stage it names must still be one",
    "#                the registry holds",
    "# The stages a run enables from its workflow are the orchestrator's (madarch-8bdc.2.5 and later); this file is the",
    "# product's own from the first commit, so a product edits it to run the stages it needs.",
    "workflows:",
  ];
  const stageList = (stages: readonly string[]): string[] => (stages.length === 0 ? ['    stages: []'] : ['    stages:', ...stages.map((stage) => `      - ${stage}`)]);
  for (const workflow of STARTER_WORKFLOWS) {
    if (workflow.name === 'branch-worktree') lines.push('  # Planned: a branch or a worktree\'s own base, overlay and publication namespace (0033, item 26) has no stage yet.');
    if (workflow.name === 'history-point') lines.push('  # Planned: materialising a merge-base the graph does not hold as a chosen point (0030) has no stage yet.');
    if (workflow.name === 'first-fill') lines.push('  # The whole walk: every stage the fill registers today, the deterministic stages and the agent stages.');
    if (workflow.name === 'update-by-commit') lines.push('  # Planned: no commit hook, background pick-up or per-file change set exists yet (0033, item 25).');
    lines.push(`  ${workflow.name}:`, `    status: ${workflow.status}`, ...stageList(workflow.stages));
  }
  return `${lines.join('\n')}\n`;
}

/** The starter manifest's text, with the product's page language when it has one. */
export function starterManifest(language?: string): string {
  const text = kindsManifest();
  return language === undefined ? text : `${text}language: ${language}\n`;
}

function kindsManifest(): string {
  const lines: string[] = [
    "# The kinds this product's wiki shows (decision 0029, docs/decisions/0029-knowledge-in-markdown-graph-as-index.md).",
    "# Each kind names where its entities come from and the template that draws them:",
    "#   source: markdown  the entity is a Markdown file of this repository (a folder of them, or one file)",
    "#   source: graph     the entity is a node of the graph the fill builds from the code repositories",
    "#   source: document  the entity is a section of a Markdown document of this or a code repository that opens with an",
    "#                     identifier (`identifier: UC` takes UC-1, UC-2 ...), a bold term of a glossary (`terms: [...]`), or",
    "#                     that stands under a heading this manifest declares (`headings: [Qualities]` takes the list items",
    "#                     under `## Qualities`, numbered or not)",
    "# A document kind may also say what its sections mean: `semantics` names the general kind of a passage (scenario, actor,",
    "# rule, quality, decision, procedure, term), which the classifier's answer is shown as, and `structure` names the",
    "# sections it holds (`structure: [Status, Context, Decision, Consequences]`), which a section without them is a finding",
    "# for. `documents.expect` lists the kinds the documents must hold: one no document section is read as is a finding too,",
    "# so the wiki says what the documents lack.",
    "# A kind with `file:` is one page; the first such kind is the home page.",
    "# `group` puts the kind in a group of the navigation and the catalogue; `labels` and `description` name and explain",
    "# the kind in each interface language (en, ru); `origin` says how its entities came to be (agent, person, code, history).",
    "# `relations` declares an edge between kinds: {attribute|dirname} puts a part of the entity into the other end's key.",
    "# `card: true` says a ground on one of the kind's entities shows a card of it — its facts, what it is related to",
    "# and the way to its page — instead of the code it was read from; a kind without it keeps the code excerpt.",
    "# `history` names the shape of the story the history block tells of the kind's entities: repositories (the",
    "# product's whole history), author, path, membership (the files a container holds), commit or task. A kind",
    "# without it gets no history page.",
    "# The views, listings and places of a kind are its declaration's too, so no screen of the wiki holds a kind of its",
    "# own. `views` lists the views a page of the kind may draw of its entities: c4-component (its modules) and state (the",
    "# state machines in its code). `er` says how the ER view reads its entities: tables (the tables the entity holds) or",
    "# links (the entity as one table and the tables its foreign keys reach). `sequence` says how the",
    "# end-to-end chain a page draws starts at its entities: route (at the entity) or symbol (at the route that reaches",
    "# it); a kind without it starts no chain. `system` says the part its entities play in the system view: container",
    "# (drawn as a box, read as the implementation a domain names, and the folder a treemap covers), data-store or",
    "# channel. `definition-block` says what the definition block finds in its entities: contract (the file it reads),",
    "# operation or channel (a row of it). `listing` says the form of its listing page: operations (what declares,",
    "# serves and calls each one), the plain table of names and places without it. `nav` says where the kind stands in",
    "# the navigation: own-page (its entities stand at a place of their own) or loop (the loop keeps its place); a",
    "# kind without it is a page among the pages by kind.",
    "# `documents.exclude` lists Markdown files that are not product documents (the files that steer a coding agent).",
    "# `roles` says, per role a reader can read as (product, analyst, architect, developer, operations, tester), which blocks of a",
    "# template stand open on a page and which groups lead the navigation. A block a role does not open stays on the page, collapsed:",
    "# one page serves every role. A role left out, and the role \"everything\", open every block in the order above.",
    "# A glossary is a document named by a kind's `terms`: each list item starts with a bold term, and may list under it",
    "# \"Also called\", \"In code\", \"Used in\" and \"Ambiguous\" (decision 0031).",
    "# `problems.rules` declares every rule the Problems page runs: the engine's predicate it keys to, the kind of",
    "# finding it makes, its Sonar kind and severity (blocker, critical, major, minor, info), the section it belongs to,",
    "# what the page offers on it and its label in each interface language. A rule may carry `params` (the marker a",
    "# debt rule reads, the secret names a product declares) and `enabled`. The engine keeps only the predicates: a rule",
    "# is run because this manifest declares it, and switching it off here is what stops it. The thresholds say when a",
    "# file is large or a hotspot.",
    "# A group is { en: <its name>, ru: <its name> }, and may name the group it is a sub-area of (`parent`) and say it",
    "# opens on the menu by itself (`open: true`); a group without a parent is an area and a group with one is a subgroup.",
    "# `catalog` declares the schema of the entity catalog (decision 0033, items 8 to 10) and every kind below declares",
    "# its row: its concept `id` (one concept has one kind), its subgroup (`group`), its `definition`, the `sources` it was",
    "# taken from as addresses a person can read, the ways it is `acquisition` (an extractor's mark, or document,",
    "# conversation, agent-from-graph, live-system, not-implemented), its implementation `status`, the",
    "# `relation-constraints` it may carry (out and in, from `catalog.relations`), and its `template-policy` (page, member",
    "# or none). A kind whose policy is `none` is catalogue data only: it shows no page yet.",
    "groups:",
    ...GROUPS.map((group) => `  ${group.name}: { en: ${yamlText(group.en)}, ru: ${yamlText(group.ru)}, short: { en: ${yamlText(group.shortEn)}, ru: ${yamlText(group.shortRu)} }${group.parent === undefined ? '' : `, parent: ${group.parent}`}${group.open === undefined ? '' : ', open: true'} }`),
    "properties:",
    ...Object.entries(PROPERTY_LABELS).map(([name, label]) => `  ${name}: ${propertyYaml(label)}`),
    "documents:",
    "  exclude: [AGENTS.md, CLAUDE.md, GEMINI.md, \"**/AGENTS.md\", \"**/CLAUDE.md\", \"**/GEMINI.md\"]",
    // The document kinds the wiki says the documents hold: one that no section of any document is read as is a finding, so a
    // product without user stories or quality requirements says so instead of showing a smaller wiki (decision 0032, section 4).
    "  expect: [doc.use-case, doc.rule, doc.requirement, doc.decision]",
    // A fence, an html comment, a rule line and a link definition are a document's furniture: the product names them as
    // blocks that hold no meaning of their own, so the reader can ignore them by a rule instead of guessing (decision
    // 0032 section 4; the review of the eighth pass).
    "  ignore: [code, html, thematicBreak, definition]",
    "roles:",
    ...ROLES.map((role) => `  ${role.name}: { lead: [${role.lead.join(', ')}], open: [${role.open.join(', ')}] }`),
    "problems:",
    "  thresholds:",
    ...Object.entries(DEFAULT_THRESHOLDS).map(([name, value]) => `    ${name}: ${value}`),
    "  rules:",
    ...STARTER_PROBLEM_RULES.map((rule) => `    ${rule.id}: ${ruleYaml(rule)}`),
    "catalog:",
    `  subgroup-kind-bound: ${CATALOG_SCHEMA['subgroup-kind-bound']}`,
    `  attributes: [${CATALOG_SCHEMA.attributes.join(', ')}]`,
    `  origin-marks: [${CATALOG_SCHEMA['origin-marks'].join(', ')}]`,
    `  extractor-mark: ${CATALOG_SCHEMA['extractor-mark']}`,
    `  statuses: [${CATALOG_SCHEMA.statuses.join(', ')}]`,
    `  template-policies: [${CATALOG_SCHEMA['template-policies'].join(', ')}]`,
    "  relations:",
    ...Object.entries(CATALOG_RELATIONS).map(([name, source]) => (source === null ? `    ${name}:` : `    ${name}: ${yamlText(source)}`)),
    "kinds:",
  ];
  for (const kind of CATALOG_KINDS) lines.push(...kindLines(kind));
  lines.push(
    "# The edge kinds the product declares: their ends, whether repeats are allowed and what tells them apart, and",
    "# the capability that fills them. A kind with a capability takes that capability's contract for its fields.",
    "edges:",
    "  - { name: code.contains, from: [code.repository, code.directory], to: [code.directory, code.file, code.gitlink], capability: git }",
    "  - { name: code.as-is, from: [code.repository], to: [code.commit], capability: git }",
    "  - { name: code.history, from: [code.repository], to: [code.commit], capability: git }",
    "  - { name: code.parent, from: [code.commit], to: [code.commit], capability: git }",
    "  - { name: code.touched, from: [code.commit], to: [code.file], capability: git }",
    "  - { name: code.authored, from: [code.author], to: [code.commit], capability: git }",
    "  - { name: code.renamed-from, from: [code.file], to: [code.file], repeats: true, discriminator: commit, capability: git }",
    "# The plugins the product holds (decision 0035, item 11): a declaration of what each reads and writes and the",
    "# files of its closure. madarch's own git reader is the first; it runs in process until the plugin host lands.",
    "plugins:",
    // The plugins a madarch release carries are declared with their folder and the major version the manifest binds;
    // the lock beside the manifest records the exact version and the closure hash (decision 0035, items 17 and 20).
    ...BUNDLED_PLUGINS.map((plugin) => `  - { id: ${plugin.id}, version: ${plugin.version.split('.')[0]}, path: ${plugin.folder}, inputs: [code.file], outputs: [${pluginOutputsOf(plugin).join(', ')}], closure: [${plugin.files.map((file) => `${plugin.folder}/${file.path}`).join(', ')}] }`),
  );
  return `${lines.join('\n')}\n`;
}

/** The declaration of one starter kind, as lines of the manifest; `group: false` leaves the group out (a manifest that declares none). */
/** What a kind's declaration writes besides its row: a manifest without groups, or one without a catalog, leaves them out. */
export interface KindLineOptions {
  readonly group?: boolean;
  readonly catalog?: boolean;
}

/**
 * The declaration of one starter kind, as lines of the manifest. `group: false` leaves the group out (a manifest
 * that declares none) and `catalog: false` leaves the catalog's row out (a manifest written before the catalog).
 */
export function kindLines(kind: CatalogKindData, options: KindLineOptions = {}): string[] {
  const lines: string[] = [`  ${kind.name}:`];
  const row = options.catalog !== false;
  if (row) {
    lines.push(`    id: ${yamlText(kind.id)}`);
    if (options.group !== false) lines.push(`    group: ${kind.group}`);
    lines.push(`    definition: ${yamlText(kind.definition)}`);
    lines.push(`    sources: [${kind.sources.map(yamlText).join(', ')}]`);
    lines.push(`    acquisition: [${kind.acquisition.map(yamlText).join(', ')}]`);
    lines.push(`    status: ${kind.status}`);
    lines.push(`    relation-constraints: { out: [${kind.out.join(', ')}], in: [${kind.into.join(', ')}] }`);
    lines.push(`    template-policy: ${kind.policy}`);
  } else if (options.group !== false) lines.push(`    group: ${kind.group}`);
  // A kind the engine cannot make yet shows no page: its row is its whole declaration. It may still carry its names,
  // so the catalog reads in both languages even where the wiki has nothing to show yet (madarch-8bdc.2.5).
  if (kind.policy !== 'none' && kind.template !== undefined && kind.source !== undefined) {
    lines.push(`    template: templates/${kind.template}`);
    lines.push(`    source: ${kind.source}`);
    if (kind.capability !== undefined) lines.push(`    capability: ${kind.capability}`);
    if (kind.fields !== undefined && kind.fields.length > 0) {
      lines.push('    fields:');
      for (const field of kind.fields) {
        // A field bound to a plugin states the binding; the plugin's own contract states its type.
        lines.push(field.binding === undefined
          ? `      - { name: ${field.name}, type: ${field.type}${field.nullable === true ? ', nullable: true' : ''}, producers: [${field.producers?.join(', ') ?? ''}]${field.reference === undefined ? '' : `, reference: ${field.reference}`} }`
          : `      - { name: ${field.name}, type: ${field.type}${field.nullable === true ? ', nullable: true' : ''}, binding: "${field.binding}" }`);
      }
    }
    if (kind.key !== undefined && kind.key.length > 0) lines.push(`    key: [${kind.key.join(', ')}]`);
    if (kind.dependsOn !== undefined) lines.push(`    depends-on: [${kind.dependsOn.join(', ')}]`);
    if (kind.origin !== undefined) lines.push(`    origin: ${kind.origin}`);
    for (const extra of kind.extra ?? []) lines.push(`    ${extra}`);
    if (kind.card === true) lines.push('    card: true');
    if (kind.history !== undefined) lines.push(`    history: ${kind.history}`);
    if (kind.views !== undefined) lines.push(`    views: [${kind.views.join(', ')}]`);
    if (kind.er !== undefined) lines.push(`    er: ${kind.er}`);
    if (kind.sequence !== undefined) lines.push(`    sequence: ${kind.sequence}`);
    if (kind.system !== undefined) lines.push(`    system: ${kind.system}`);
    if (kind.definitionBlock !== undefined) lines.push(`    definition-block: ${kind.definitionBlock}`);
    if (kind.listing !== undefined) lines.push(`    listing: ${kind.listing}`);
    if (kind.nav !== undefined) lines.push(`    nav: ${kind.nav}`);
    const details = DETAILS[kind.name];
    if (details !== undefined && details.length > 0) lines.push(`    details: [${details.join(', ')}]`);
  }
  if (kind.en !== undefined && kind.ru !== undefined) {
    lines.push('    labels:');
    lines.push(`      en: { one: ${yamlText(kind.en[0])}, many: ${yamlText(kind.en[1])} }`);
    lines.push(`      ru: { one: ${yamlText(kind.ru[0])}, many: ${yamlText(kind.ru[1])} }`);
  }
  if (kind.describe !== undefined) {
    lines.push('    description:');
    lines.push(`      en: ${yamlText(kind.describe[0])}`);
    lines.push(`      ru: ${yamlText(kind.describe[1])}`);
  }
  return lines;
}
const KINDS = kindsManifest();
const WORKFLOWS = workflowsManifest();

/** The plugin lock's text (decision 0035, item 20): each bundled plugin's exact version and closure hash. */
function pluginLockText(): string {
  const lines = [
    '# The plugins this product runs (decision 0035, item 20): each one\'s exact version and the hash of its closure.',
    '# A fill runs exactly what this lock names. A changed closure needs a person\'s approval before it runs.',
    'plugins:',
  ];
  for (const plugin of BUNDLED_PLUGINS) lines.push(`  - { id: ${plugin.id}, version: ${plugin.version}, closure: ${bundledClosureHash(plugin)}, path: ${plugin.folder} }`);
  return `${lines.join('\n')}\n`;
}

/** The output kinds a bundled plugin's own contract declares. */
function pluginOutputsOf(plugin: BundledPlugin): string[] {
  const contract = JSON.parse(plugin.files.find((file) => file.path === 'contract.json')!.content) as { outputs: { vertices: { kind: string }[] } };
  return contract.outputs.vertices.map((vertex) => vertex.kind);
}

export const STARTER_FILES: readonly StarterFile[] = [
  { path: 'madarch/kinds.yaml', content: KINDS },
  { path: 'madarch/plugins.lock', content: pluginLockText() },
  { path: WORKFLOWS_FILE, content: WORKFLOWS },
  // The plugins a release carries are the product's own files from its first commit (decision 0035, items 1 and 3).
  ...bundledPluginFiles().map((file) => ({ path: file.path, content: file.content })),
  ...Object.entries(TEMPLATES).map(([name, content]) => ({ path: `templates/${name}`, content })),
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

/**
 * The kinds the loop of questions and corrections needs (madarch-m38l.7): `question` and `correction`, their folders and
 * their templates. A product made before they existed is given them when a refresh starts: the manifest gains the
 * missing declarations (its comments kept) and the templates that are absent are written. Answers the paths it wrote.
 */
export function ensureLoopKinds(productFolder: string): string[] {
  const written: string[] = [];
  const file = join(productFolder, KINDS_FILE);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`src/knowledge/seed.ts: ${file} cannot be read to add the question and correction kinds: ${(error as Error).message}`);
  }
  const document = parseDocument(text);
  if (document.errors.length > 0) throw new Error(`${file}:${document.errors[0]!.linePos?.[0].line ?? 1}: the manifest cannot be read, so the question and correction kinds are not added: ${document.errors[0]!.message.split('\n')[0]}`);
  const wanted = STARTER_KINDS.filter((kind) => kind.name === 'question' || kind.name === 'correction' || kind.name === 'administrator-guide' || kind.name === 'user-guide');
  let changed = false;
  for (const kind of wanted) {
    if (document.hasIn(['kinds', kind.name])) continue;
    // A group the manifest does not declare would make the kind a finding: the kind is then declared without one.
    for (const detail of DETAILS[kind.name] ?? []) {
      if (document.hasIn(['properties', detail])) continue;
      const declaration = propertyDeclaration(detail);
      if (declaration !== undefined) document.setIn(['properties', detail], document.createNode(declaration));
    }
    const parsed = parseDocument(`kinds:\n${kindLines(kind, { group: document.hasIn(['groups', kind.group]), catalog: document.hasIn(['catalog']) }).join('\n')}\n`).getIn(['kinds', kind.name]) as { toJSON(): unknown };
    document.setIn(['kinds', kind.name], document.createNode(parsed.toJSON()));
    changed = true;
  }
  for (const name of ['question.liquid', 'correction.liquid', 'guide.liquid']) {
    const target = join(productFolder, 'templates', name);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, TEMPLATES[name]!, { flag: 'wx' });
    written.push(`templates/${name}`);
  }
  if (changed) {
    writeFileSync(file, document.toString(), 'utf8');
    written.push(KINDS_FILE);
  }
  return written;
}
