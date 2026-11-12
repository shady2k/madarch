import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { CATALOG_KINDS, CATALOG_KIND_FILES, type CatalogKindData } from './catalog-starter.js';
import { stringify } from 'yaml';
import { parseCatalogYaml } from '../product/manifest/kinds.js';
import { CATALOG_FILES } from './catalog-assets.js';
import { STARTER_WORKFLOWS } from './starter-workflows.js';
import { DEFAULT_STARTER_TEMPLATE, starterTemplateOf, type StarterTemplate } from './starter-templates.js';
import { BUNDLED_PLUGINS, bundledClosureHash, bundledPluginFiles, type BundledPlugin } from '../plugin/bundled.js';
import { WORKFLOWS_FILE } from '../product/manifest/workflows.js';

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
  /** The file's text; a file that is not text answers an empty text and its `bytes`. */
  content: string;
  /** The bytes of a file the product copies as it is (a plugin's WebAssembly module). */
  bytes?: Uint8Array;
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
{% block around %}{% relations title="Relations" title-ru="Связи" %}{% endblock %}
{% block source %}{% endblock %}
{% block calls %}{% endblock %}
{% block chain %}{% endblock %}
{% block parts %}{% endblock %}
{% block relations %}{% endblock %}
{% block describedby %}{% endblock %}
{% block mentionedon %}{% linkedfrom title="Mentioned on" title-ru="Упоминается на" hide-empty="true" %}{% endblock %}
`,
  'partials/around.liquid': `{% relations title=title title-ru=title_ru %}`,
  'partials/pages-about.liquid': `{% related title=title title-ru=title_ru relation="relates" %}`,
  'partials/source.liquid': `{% source title=title title-ru=title_ru %}`,
  'partials/relations.liquid': `{% related title=title title-ru=title_ru %}`,
  'partials/history.liquid': `{% history title=title title-ru=title_ru %}`,
  // The home page is read in a minute: what the product is, its system map, and the history as one line of totals and
  // the five files that change most, with the whole list of files one click away. The treemap and the relation table
  // are not on it: they live on the pages of what they describe.
  'product.liquid': `{% layout "./entity.liquid" %}
{# The home page is the product's overview (madarch-47vw.5): what it is, how it works, its data, its key terms, where it
   stands and where to start reading. Each section is an engine block; one without data says which entity's fill brings
   it. The product's own template may reorder or leave out a section. #}
{% block lead %}{% overview-about title="What the product is" title-ru="Что это за продукт" %}
{% overview-how title="How it works" title-ru="Как он работает" %}
{% overview-data title="Data" title-ru="Данные" %}
{% overview-terms title="Key terms" title-ru="Ключевые термины" %}
{% overview-status title="Where it stands" title-ru="Где он сейчас" %}
{% overview-reading title="Where to start reading" title-ru="С чего начать читать" %}{% endblock %}
`,
  'domain.liquid': `{% layout "./entity.liquid" %}
{# A domain page opens with what the domain is and how it goes: its text, the architecture of the domain and the
   chain a reader follows through it, then where it stands in the graph and what implements it. #}
{% block lead %}{% body %}{% system title="Architecture of the domain" title-ru="Архитектура домена" view="domain" %}{% sequence title="End-to-end chain" title-ru="Сквозная цепочка" scenario=page.title %}{% endblock %}
{% block around %}{% render "./partials/around.liquid", title="Around this page", title_ru="Вокруг этой страницы" %}{% endblock %}
{% block describedby %}{% related title="Implemented by" title-ru="Реализуют" relation="relates" %}{% endblock %}
`,
  'dismissal.liquid': `{% layout "./entity.liquid" %}
{% block lead %}{{ page.reason }}{% endblock %}
{% block details %}{% properties title="Details" title-ru="Сведения" %}{% endblock %}
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
{% block lead %}{% file-page %}{% endblock %}
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
{% block lead %}{% if lang == "ru" %}Статическое чтение показывает таблицы, явно объявленные в коде. Таблицы, создаваемые во время выполнения, не показаны до заполнения агентом; это не полная схема базы данных.{% else %}Static reading shows tables explicitly declared in code. Tables generated at run time are not shown until the agent fill; this is not the complete database schema.{% endif %}{% endblock %}
{% block details %}{% properties title="Details" title-ru="Сведения" %}{% endblock %}
{% block around %}{% render "./partials/around.liquid", title="Around this", title_ru="Вокруг этого" %}{% endblock %}
{% block parts %}{% assign tables_prefix = "code.table:" | append: page.label | append: "/" %}
{% children title="Tables" title-ru="Таблицы" kind="code.table" prefix=tables_prefix relation="code.contains" %}
{% assign migrations_prefix = "code.migration:" | append: page.label | append: "/" %}
{% children title="Migrations" title-ru="Миграции" kind="code.migration" prefix=migrations_prefix relation="code.contains" %}
{% er title="Tables and their links" title-ru="Таблицы и связи между ними" limit=60 %}{% endblock %}
{% block relations %}{% render "./partials/relations.liquid", title="Relations", title_ru="Связи" %}{% endblock %}
{% block describedby %}{% render "./partials/pages-about.liquid", title="Pages about this database", title_ru="Страницы об этой базе данных" %}{% endblock %}
`,
  'table.liquid': `{% layout "./entity.liquid" %}
{% block details %}{% properties title="Details" title-ru="Сведения" %}{% endblock %}
{% block around %}{% render "./partials/around.liquid", title="Around this", title_ru="Вокруг этого" %}{% endblock %}
{% block source %}{% render "./partials/source.liquid", title="Source", title_ru="Исходный текст" %}{% endblock %}
{% block parts %}{% assign columns_prefix = "code.column:" | append: page.keyrest | append: "/" %}
{% children title="Columns" title-ru="Столбцы" kind="code.column" prefix=columns_prefix relation="code.has-column" limit=200 %}
{% assign indexes_prefix = "code.index:" | append: page.keyrest | append: "/" %}
{% children title="Indexes" title-ru="Индексы" kind="code.index" prefix=indexes_prefix relation="code.has-index" %}
{% er title="The table and its links" title-ru="Таблица и её связи" %}{% endblock %}
{% block relations %}{% render "./partials/relations.liquid", title="Relations", title_ru="Связи" %}{% endblock %}
{% block describedby %}{% render "./partials/pages-about.liquid", title="Pages about this table", title_ru="Страницы об этой таблице" %}{% endblock %}
`,
  'test-quarantine.liquid': `{% layout "./entity.liquid" %}
{% block details %}{% properties title="Quarantine" title-ru="Карантин" %}{% endblock %}
{% block source %}{% source title="Test" title-ru="Тест" %}{% endblock %}
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
{% block details %}{% properties title="Details" title-ru="Сведения" %}{% endblock %}
`,
  'correction.liquid': `{% layout "./entity.liquid" %}
{% block details %}{% properties title="Details" title-ru="Сведения" %}{% endblock %}
`,
  'task.liquid': `{% layout "./entity.liquid" %}
{% block details %}{% properties title="Details" title-ru="Сведения" %}{% endblock %}
`,
};

/**
 * The groups of the navigation and the catalogue, as the catalog declares them: an area, then its subgroups. The
 * engine holds none of them; the product's manifest names every one.
 */
interface CatalogMetadata {
  groups: Record<string, { parent?: string }>;
  roles: Record<string, { lead: string[]; open: string[] }>;
  documents: { expect: string[] };
  edges?: { from: string[]; to: string[] }[];
}

const CATALOG_METADATA = parseCatalogYaml(CATALOG_FILES['catalog.yaml']!) as CatalogMetadata;

/** The metadata a starter selection uses, read from the catalogue's data, not an engine-owned declaration. */
function catalogMetadata(kinds: readonly CatalogKindData[]): string {
  const names = new Set(kinds.map((kind) => kind.name));
  const used = new Set<string>();
  for (const kind of kinds) {
    let group: string | undefined = kind.group;
    while (group !== undefined && !used.has(group)) {
      used.add(group);
      group = CATALOG_METADATA.groups[group]?.parent;
    }
  }
  return stringify({
    ...CATALOG_METADATA,
    groups: Object.fromEntries(Object.entries(CATALOG_METADATA.groups).filter(([name]) => used.has(name))),
    documents: { ...CATALOG_METADATA.documents, expect: CATALOG_METADATA.documents.expect.filter((name) => names.has(name)) },
    roles: Object.fromEntries(Object.entries(CATALOG_METADATA.roles)
      .map(([name, role]) => [name, { ...role, lead: role.lead.filter((group) => used.has(group)) }] as const)
      .filter(([, role]) => role.lead.length > 0)),
    edges: CATALOG_METADATA.edges?.filter((edge) => [...edge.from, ...edge.to].some((name) => names.has(name))),
  });
}

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

/** Plugin declarations follow the bundled plugins' own contracts and closures. */
function pluginManifest(kinds: readonly CatalogKindData[]): Record<string, unknown>[] {
  const names = new Set(kinds.map((kind) => kind.name));
  return BUNDLED_PLUGINS.filter((plugin) => pluginUsesCatalogue(plugin) ? kinds.some((kind) => kind.source === 'graph') : pluginOutputsOf(plugin).some((kind) => names.has(kind)))
    .map((plugin) => ({ id: plugin.id, version: Number(plugin.version.split('.')[0]), path: plugin.folder,
      inputs: pluginUsesCatalogue(plugin) ? [] : ['code.file'], outputs: pluginOutputsOf(plugin), closure: plugin.files.map((file) => `${plugin.folder}/${file.path}`) }));
}

/** The plugin lock's text (decision 0035, item 20): each bundled plugin's exact version and closure hash. */
function pluginLockText(plugins: readonly BundledPlugin[]): string {
  const lines = [
    '# The plugins this product runs (decision 0035, item 20): each one\'s exact version and the hash of its closure.',
    '# A fill runs exactly what this lock names. A changed closure needs a person\'s approval before it runs.',
    'plugins:',
  ];
  for (const plugin of plugins) lines.push(`  - { id: ${plugin.id}, version: ${plugin.version}, closure: ${bundledClosureHash(plugin)}, path: ${plugin.folder} }`);
  return `${lines.join('\n')}\n`;
}

/** Whether the bundled plugin fills the catalogue rather than a fixed set of output kinds. */
function pluginUsesCatalogue(plugin: BundledPlugin): boolean {
  const held = plugin.files.find((file) => file.path === 'plugin.json')?.content;
  if (typeof held !== 'string') throw new Error(`src/knowledge/seed.ts:1: the bundled plugin ${plugin.id} carries no plugin.json text`);
  const manifest = JSON.parse(held) as { agent?: { catalogue?: boolean } };
  return manifest.agent?.catalogue === true;
}

/** The output kinds a bundled plugin's own contract declares. */
function pluginOutputsOf(plugin: BundledPlugin): string[] {
  const held = plugin.files.find((file) => file.path === 'contract.json')?.content;
  if (typeof held !== 'string') throw new Error(`src/knowledge/seed.ts:1: the bundled plugin ${plugin.id} carries no contract.json text to name its output kinds from`);
  const contract = JSON.parse(held) as { outputs: { vertices: { kind: string }[] } };
  return contract.outputs.vertices.map((vertex) => vertex.kind);
}

/** The templates a set of kind templates names, with every layout and partial they render, in code point order. */
function templatesUsedBy(kindTemplates: readonly string[]): Record<string, string> {
  const wanted = new Set<string>();
  const visit = (path: string): void => {
    if (wanted.has(path)) return;
    const content = TEMPLATES[path];
    if (content === undefined) throw new Error(`src/knowledge/seed.ts:1: the template ${path} is named by a kind or a template and the starter set holds none`);
    wanted.add(path);
    for (const match of content.matchAll(/["']\.\/([^"']+\.liquid)["']/g)) visit(match[1]!);
  };
  for (const template of kindTemplates) visit(template);
  // In the starter set's own order (`TEMPLATES`), never sorted: the product's file list keeps the order `madarch new`
  // has always written (the base page and the partials first, then the kinds' templates).
  return Object.fromEntries(Object.keys(TEMPLATES).filter((path) => wanted.has(path)).map((path) => [path, TEMPLATES[path]!]));
}

/**
 * The starter files one template writes: its manifest's kinds, and the page templates, the plugins and the workflows
 * those kinds use, and nothing they do not. A template that declares no kinds writes nothing at all — the person starts
 * from a product with no manifest.
 */
/** The catalogue kinds one template declares, in the catalogue's order; none when it declares no manifest. */
export function starterKindNames(template: StarterTemplate): readonly string[] {
  if (template.kinds === 'none') return [];
  if (template.kinds === 'all') return CATALOG_KINDS.map((kind) => kind.name);
  const names = new Set<string>();
  for (const selector of template.kinds) {
    const prefix = selector.replace(/\/$/, '') + '/';
    const matches = CATALOG_KINDS.filter((kind) => kind.name === selector || CATALOG_KIND_FILES[kind.name]?.startsWith(prefix));
    if (matches.length === 0) throw new Error(`catalog/templates/${template.id}.yaml:1: unknown kind or folder ${JSON.stringify(selector)}`);
    for (const kind of matches) names.add(kind.name);
  }
  return CATALOG_KINDS.filter((kind) => names.has(kind.name)).map((kind) => kind.name);
}

/** The kinds one template's manifest shows as pages: the catalogue kinds whose template policy is not `none`. */
export function starterPageKindNames(template: StarterTemplate): readonly string[] {
  const named = new Set(starterKindNames(template));
  return CATALOG_KINDS.filter((kind) => named.has(kind.name) && kind.policy !== 'none').map((kind) => kind.name);
}

export function starterFilesFor(template: StarterTemplate): readonly StarterFile[] {
  if (template.kinds === 'none') return [];
  const kinds = template.kinds === 'all' ? undefined : starterKindNames(template);
  const chosen = kinds === undefined ? CATALOG_KINDS : CATALOG_KINDS.filter((kind) => kinds.includes(kind.name));
  const names = new Set(chosen.map((kind) => kind.name));
  const plugins = BUNDLED_PLUGINS.filter((plugin) => pluginUsesCatalogue(plugin) ? chosen.some((kind) => kind.source === 'graph') : pluginOutputsOf(plugin).some((kind) => names.has(kind)));
  const templates = templatesUsedBy(chosen.flatMap((kind) => (kind.template === undefined ? [] : [kind.template])));
  // A workflow is the fill's stage set; only a kind read from a code repository needs one, and a tracker needs none.
  const workflows = chosen.some((kind) => kind.source === 'graph');
  return [
    { path: 'madarch/catalog.yaml', content: catalogMetadata(chosen) + (plugins.length === 0 ? '' : stringify({ plugins: pluginManifest(chosen) })) },
    ...chosen.map((kind) => ({ path: `madarch/kinds/${CATALOG_KIND_FILES[kind.name]}`, content: CATALOG_FILES[CATALOG_KIND_FILES[kind.name]!]! })),
    ...(plugins.length === 0 ? [] : [{ path: 'madarch/plugins.lock', content: pluginLockText(plugins) }]),
    ...(workflows ? [{ path: WORKFLOWS_FILE, content: workflowsManifest() }] : []),
    ...bundledPluginFiles()
      .filter((file) => plugins.some((plugin) => file.path.startsWith(`${plugin.folder}/`)))
      .map((file) => ({ path: file.path, content: file.content, ...(file.bytes === undefined ? {} : { bytes: file.bytes }) })),
    ...Object.entries(templates).map(([name, content]) => ({ path: `templates/${name}`, content })),
  ];
}

/** The files the default template writes: the whole starter set, as the first products were made. */
export const STARTER_FILES: readonly StarterFile[] = starterFilesFor(starterTemplateOf(DEFAULT_STARTER_TEMPLATE)!);

/**
 * Writes one template's files into a product that has none: the files that are absent, never one that is there. Answers
 * the paths it wrote. An error names the file that could not be written.
 */
export function seedStarterSet(productFolder: string, templateId: string = DEFAULT_STARTER_TEMPLATE, templates?: readonly StarterTemplate[]): string[] {
  const template = starterTemplateOf(templateId, templates);
  if (template === undefined) throw new Error(`src/knowledge/seed.ts:1: no starter template is declared with the id ${JSON.stringify(templateId)}`);
  // The default template's files are the constant the tests and the catalog check read the starter set through.
  const files = templates === undefined && template.id === DEFAULT_STARTER_TEMPLATE ? STARTER_FILES : starterFilesFor(template);
  const written: string[] = [];
  const root = realpathSync(productFolder);
  for (const starter of files) {
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
      writeFileSync(target, starter.bytes ?? starter.content, { flag: 'wx' });
    } catch (error) {
      throw new Error(`src/knowledge/seed.ts: ${target} could not be written to give the product its starter set: ${(error as Error).message}`);
    }
    written.push(starter.path);
  }
  return written;
}

