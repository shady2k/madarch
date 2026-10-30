import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { parseDocument } from 'yaml';
import { KINDS_FILE } from './kinds.js';
import { DEFAULT_THRESHOLDS } from '../problems/types.js';
import type { ProblemSettings, RuleSpec } from '../problems/types.js';

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
{% block lead %}{% if page.language %}A {{ page.language }} service.{% endif %}{% if page.frameworks %} Frameworks: {{ page.frameworks }}.{% endif %}{% if page.infrastructure %} Infrastructure: {{ page.infrastructure }}.{% endif %}{% if page.testFramework %} Tests: {{ page.testFramework }}.{% endif %}{% endblock %}
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
{% block lead %}{{ page.path }}{% endblock %}
{% block around %}{% render "./partials/around.liquid", title="Around this file", title_ru="Вокруг этого файла" %}{% endblock %}
{% block source %}{% render "./partials/source.liquid", title="Source", title_ru="Исходный текст" %}{% endblock %}
{% block parts %}{% history title="Change history" title-ru="История изменений" %}
{% modules title="State machines" title-ru="Конечные автоматы" %}
{% related title="Declares" title-ru="Объявляет" relation="code.contains" direction="out" kind="code.symbol" limit=60 %}
{% related title="Imports" title-ru="Импортирует" relation="code.imports" direction="out" %}
{% related title="Imported by" title-ru="Импортируют" relation="code.imports" direction="in" %}
{% related title="Contained in" title-ru="Входит в" relation="code.contains" direction="in" %}{% endblock %}
{% block describedby %}{% render "./partials/pages-about.liquid", title="Pages about this file", title_ru="Страницы об этом файле" %}{% endblock %}
`,
  'symbol.liquid': `{% layout "./entity.liquid" %}
{% block lead %}{% if page.symbolKind %}{{ page.symbolKind }} in {% endif %}{{ page.path }}{% endblock %}
{% block source %}{% render "./partials/source.liquid", title="Source", title_ru="Исходный текст" %}{% endblock %}
{# A function's page reads as it did: what it calls and is called by, where it stands, the state machines of its code, then
   the chain a reader follows from it. #}
{% block calls %}{% callers title="Callers" title-ru="Кто вызывает" %}
{% callees title="Calls" title-ru="Что вызывает" %}{% endblock %}
{% block around %}{% render "./partials/around.liquid", title="Around this function", title_ru="Вокруг этой функции" %}{% endblock %}
{% block chain %}{% modules title="State machines" title-ru="Конечные автоматы" %}
{% sequence title="End-to-end chain" title-ru="Сквозная цепочка" scenario=page.label %}{% endblock %}
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
{% implementedby title="Implemented by" title-ru="Чем реализовано" %}
{% linkedfrom title="Linked from" title-ru="Ссылаются на него" %}{% endblock %}
`,
  'enrichment.liquid': `{% layout "./entity.liquid" %}
{% block lead %}{% body %}{% endblock %}
{% block chain %}{% sequence title="End-to-end chain" title-ru="Сквозная цепочка" scenario=page.title %}{% endblock %}
{% block relations %}{% render "./partials/relations.liquid", title="Relations", title_ru="Связи" %}{% endblock %}
{% block describedby %}{% render "./partials/pages-about.liquid", title="Pages about this", title_ru="Страницы об этом" %}{% endblock %}
`,
  'term.liquid': `{% layout "./entity.liquid" %}
{% block lead %}{% term title="Definition" title-ru="Определение" %}{% endblock %}
{% block relations %}{% stated title="Stated in" title-ru="Где описано" %}
{% linkedfrom title="Linked from" title-ru="Ссылаются на него" %}{% endblock %}
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

export interface StarterKind {
  name: string;
  template: keyof typeof TEMPLATES;
  source: 'markdown' | 'graph' | 'document';
  group: string;
  origin?: 'agent' | 'person' | 'code' | 'history';
  /** `one` and `many` per language. */
  en: [string, string];
  ru: [string, string];
  describe: [string, string];
  /** Further lines of the kind's declaration, indented by the generator. */
  extra?: string[];
}

export const GROUPS: readonly { name: string; en: string; ru: string; parent?: string; open?: boolean }[] = [
  { name: 'product', en: 'Product knowledge', ru: 'Знания о продукте', open: true },
  { name: 'code', en: 'Code', ru: 'Код' },
  { name: 'code.structure', en: 'Structure', ru: 'Устройство', parent: 'code' },
  { name: 'code.analysis', en: 'Analysis', ru: 'Анализ', parent: 'code' },
  { name: 'contracts', en: 'Contracts', ru: 'Контракты' },
  { name: 'data', en: 'Data', ru: 'Данные' },
  { name: 'operations', en: 'Operations', ru: 'Эксплуатация' },
  { name: 'operations.configuration', en: 'Configuration', ru: 'Настройка', parent: 'operations' },
  { name: 'operations.dependencies', en: 'Dependencies', ru: 'Зависимости', parent: 'operations' },
  { name: 'operations.build-deploy', en: 'Build and deploy', ru: 'Сборка и развёртывание', parent: 'operations' },
  { name: 'operations.ci-cd', en: 'CI/CD', ru: 'CI/CD', parent: 'operations' },
  { name: 'operations.runtime', en: 'Runtime', ru: 'Работа системы', parent: 'operations' },
  { name: 'operations.newcomer', en: 'Newcomer', ru: 'Новичку', parent: 'operations' },
  { name: 'tests', en: 'Tests', ru: 'Тесты' },
  { name: 'history', en: 'History', ru: 'История' },
];

/** What each role opens on a page and puts first in the navigation (decision 0031); the product edits them. */
export const ROLES: readonly { name: string; lead: string[]; open: string[] }[] = [
  { name: 'product', lead: ['product', 'tests'], open: ['stated', 'implementedby', 'linkedfrom', 'related', 'properties'] },
  { name: 'analyst', lead: ['product', 'data', 'contracts'], open: ['stated', 'implementedby', 'linkedfrom', 'related', 'properties', 'er', 'sequence', 'children'] },
  { name: 'architect', lead: ['product', 'code', 'contracts', 'data'], open: ['graph', 'related', 'sequence', 'er', 'stated', 'implementedby', 'linkedfrom', 'properties', 'children'] },
  { name: 'developer', lead: ['code', 'contracts', 'data', 'tests'], open: ['source', 'callers', 'callees', 'sequence', 'graph', 'related', 'history', 'properties', 'children', 'er', 'stated'] },
  { name: 'operations', lead: ['operations', 'data', 'contracts'], open: ['properties', 'related', 'history', 'children', 'source', 'er', 'stated'] },
  { name: 'tester', lead: ['tests', 'product'], open: ['stated', 'implementedby', 'linkedfrom', 'related', 'properties', 'callers', 'children'] },
];

export const STARTER_KINDS: readonly StarterKind[] = [
  { name: 'product', template: 'product.liquid', source: 'markdown', group: 'product', en: ['Product', 'Products'], ru: ['Продукт', 'Продукты'], describe: ['What the product is, for whom, and its architecture: the home page the agent writes.', 'Что это за продукт, для кого и как устроен: главная страница, которую пишет агент.'], extra: ['file: docs/product.md'] },
  { name: 'domain', template: 'domain.liquid', source: 'markdown', group: 'product', en: ['Domain', 'Domains'], ru: ['Домен', 'Домены'], describe: ['A part of the business the product serves, such as payment or ordering: how it works and what implements it.', 'Часть бизнеса, которую обслуживает продукт, например оплата или заказы: как она работает и что её реализует.'], extra: ['folder: docs/domains'] },
  { name: 'administrator-guide', template: 'guide.liquid', source: 'markdown', group: 'product', origin: 'agent', en: ['Administrator guide', 'Administrator guide'], ru: ['Руководство администратора', 'Руководство администратора'], describe: ['Grounded setup and operations, with independent walkthrough status.', 'Запуск и эксплуатация с основаниями в исходниках и независимым статусом прохождения.'], extra: ['file: docs/guides/administrator.md'] },
  { name: 'user-guide', template: 'guide.liquid', source: 'markdown', group: 'product', origin: 'agent', en: ['User guide', 'User guide'], ru: ['Руководство пользователя', 'Руководство пользователя'], describe: ['Supported tasks and API procedures, with known gaps.', 'Поддерживаемые задачи и API-процедуры с известными пробелами.'], extra: ['file: docs/guides/user.md'] },
  { name: 'question', template: 'question.liquid', source: 'markdown', group: 'product', origin: 'agent', en: ['Question', 'Questions'], ru: ['Вопрос', 'Вопросы'], describe: ['Something the agent could not settle from the code and the documents; a person answers it.', 'То, что агент не смог решить по коду и документам; отвечает человек.'], extra: ['folder: docs/questions'] },
  { name: 'correction', template: 'correction.liquid', source: 'markdown', group: 'product', origin: 'person', en: ['Correction', 'Corrections'], ru: ['Поправка', 'Поправки'], describe: ['A person\'s note that a statement is wrong, and why; the agent takes it into account at the next refresh.', 'Заметка человека о том, что утверждение неверно, и почему; агент учтёт её при следующем обновлении.'], extra: ['folder: docs/corrections'] },
  { name: 'task', template: 'task.liquid', source: 'markdown', group: 'product', origin: 'person', en: ['Task', 'Tasks'], ru: ['Задача', 'Задачи'], describe: ['A scoped change the person plans, with the pages and statements it affects.', 'Запланированное изменение с указанной областью и затронутыми страницами и утверждениями.'], extra: ['folder: docs/tasks'] },
  { name: 'doc.use-case', template: 'entity-text.liquid', source: 'document', group: 'product', origin: 'person', en: ['Use case', 'Use cases'], ru: ['Сценарий', 'Сценарии'], describe: ['A way a person uses the product (UC-1, UC-2 ...), as the documents state it.', 'Способ, которым человек пользуется продуктом (UC-1, UC-2 ...), как его описывают документы.'], extra: ['identifier: UC', 'semantics: scenario', 'headings: [Use cases]'] },
  { name: 'doc.rule', template: 'entity-text.liquid', source: 'document', group: 'product', origin: 'person', en: ['Business rule', 'Business rules'], ru: ['Бизнес-правило', 'Бизнес-правила'], describe: ['A rule the product keeps (BR-1, BR-2 ...), with the code that implements it.', 'Правило, которое соблюдает продукт (BR-1, BR-2 ...), и код, который его реализует.'], extra: ['identifier: BR', 'semantics: rule', 'headings: [Business rules]'] },
  { name: 'doc.decision', template: 'entity-text.liquid', source: 'document', group: 'product', origin: 'person', en: ['Decision', 'Decisions'], ru: ['Решение', 'Решения'], describe: ['An architecture decision record (ADR-0001 ...): what was decided and why.', 'Запись об архитектурном решении (ADR-0001 ...): что решили и почему.'], extra: ['identifier: ADR', 'semantics: decision', 'structure: [Status, Context, Decision, Consequences]'] },
  { name: 'doc.requirement', template: 'entity-text.liquid', source: 'document', group: 'product', origin: 'person', en: ['Requirement', 'Requirements'], ru: ['Требование', 'Требования'], describe: ['Another item of the documents: a requirement, a story, a feature, numbered (FR-1, NFR-2, REQ-3, US-4 ...) or not, as in an unnumbered Qualities section.', 'Другой пункт документов: требование, история, возможность; пронумерованный (FR-1, NFR-2, REQ-3, US-4 ...) или нет, как в разделе Qualities без номеров.'], extra: ['identifier: [FR, NFR, REQ, PR, US]', 'semantics: quality', 'headings: [Qualities, Non-functional requirements]'] },
  { name: 'enrichment', template: 'enrichment.liquid', source: 'markdown', group: 'product', origin: 'agent', en: ['Enrichment', 'Enrichments'], ru: ['Обогащение', 'Обогащения'], describe: ['What the agent established about a use case, a rule or a decision of the documents: its parts in their own order, the code that carries it out, and the chain from its route — written beside the person\'s text, never over it.', 'То, что агент установил о сценарии, правиле или решении из документов: их части в своём порядке, код, который их выполняет, и цепочка от маршрута — записано рядом с текстом человека, а не поверх него.'], extra: ['folder: docs/enrichment'] },
  { name: 'doc.term', template: 'term.liquid', source: 'document', group: 'product', origin: 'person', en: ['Glossary term', 'Glossary terms'], ru: ['Термин', 'Термины'], describe: ['A term of the product\'s language, defined in a glossary.', 'Слово из языка продукта с определением из глоссария.'], extra: ['terms: ["**/glossary*.md"]', 'semantics: term'] },
  { name: 'code.service', template: 'service.liquid', source: 'graph', group: 'code.structure', en: ['Service', 'Services'], ru: ['Сервис', 'Сервисы'], describe: ['A deployable part of the system, read from its manifest.', 'Развёртываемая часть системы, прочитанная из её манифеста.'], extra: ['relations:', '  - { type: code.contains, to: "code.package:{span.path|dirname}" }'] },
  { name: 'code.package', template: 'package.liquid', source: 'graph', group: 'code.structure', en: ['Package', 'Packages'], ru: ['Пакет', 'Пакеты'], describe: ['The folder a service\'s manifest sits in, with its tests and frameworks.', 'Папка с манифестом сервиса, его тесты и фреймворки.'] },
  { name: 'code.module', template: 'module.liquid', source: 'graph', group: 'code.structure', en: ['Module', 'Modules'], ru: ['Модуль', 'Модули'], describe: ['A folder of code with a purpose of its own, with the modules it depends on.', 'Папка кода со своим назначением и модули, от которых она зависит.'] },
  { name: 'code.file', template: 'file.liquid', source: 'graph', group: 'code.structure', en: ['File', 'Files'], ru: ['Файл', 'Файлы'], describe: ['A file of a code repository.', 'Файл репозитория кода.'] },
  { name: 'code.symbol', template: 'symbol.liquid', source: 'graph', group: 'code.structure', en: ['Symbol', 'Symbols'], ru: ['Символ', 'Символы'], describe: ['A function, class or constant, with its callers and callees.', 'Функция, класс или константа, кто её вызывает и что она вызывает.'] },
  { name: 'code.entry-point', template: 'item.liquid', source: 'graph', group: 'code.structure', en: ['Entry point', 'Entry points'], ru: ['Точка входа', 'Точки входа'], describe: ['Where a process of the system starts running.', 'Место, где начинает работать процесс системы.'] },
  { name: 'code.cycle', template: 'item-plain.liquid', source: 'graph', group: 'code.analysis', en: ['Dependency cycle', 'Dependency cycles'], ru: ['Цикл зависимостей', 'Циклы зависимостей'], describe: ['Files or modules that import one another in a ring.', 'Файлы или модули, которые импортируют друг друга по кругу.'] },
  { name: 'code.debt', template: 'item-plain.liquid', source: 'graph', group: 'code.analysis', en: ['Debt marker', 'Debt markers'], ru: ['Маркер долга', 'Маркеры долга'], describe: ['A TODO or FIXME a comment left in the code.', 'TODO или FIXME, оставленный комментарием в коде.'] },
  { name: 'code.facet', template: 'item-plain.liquid', source: 'graph', group: 'code.analysis', en: ['File facet', 'File facets'], ru: ['Срез файла', 'Срезы файлов'], describe: ['What the code reader found out about a file: its role and language.', 'Что читатель кода выяснил о файле: его роль и язык.'] },
  { name: 'code.input', template: 'item.liquid', source: 'graph', group: 'code.analysis', en: ['Input', 'Inputs'], ru: ['Входные данные', 'Входные данные'], describe: ['A value that enters the code from outside, such as a query parameter.', 'Значение, которое попадает в код снаружи, например параметр запроса.'] },
  { name: 'code.sql-build', template: 'item-plain.liquid', source: 'graph', group: 'code.analysis', en: ['SQL build', 'SQL builds'], ru: ['Сборка SQL', 'Сборки SQL'], describe: ['A function that builds SQL text by joining strings.', 'Функция, которая собирает текст SQL склейкой строк.'] },
  { name: 'code.sql-sink', template: 'item.liquid', source: 'graph', group: 'code.analysis', en: ['SQL sink', 'SQL sinks'], ru: ['Выполнение SQL', 'Места выполнения SQL'], describe: ['A call that runs SQL text as it is.', 'Вызов, который выполняет текст SQL как есть.'] },
  { name: 'code.route', template: 'route.liquid', source: 'graph', group: 'contracts', en: ['HTTP route', 'HTTP routes'], ru: ['HTTP-маршрут', 'HTTP-маршруты'], describe: ['An HTTP route a service serves, read from its code.', 'HTTP-маршрут, который обслуживает сервис, прочитанный из кода.'] },
  { name: 'code.operation', template: 'operation.liquid', source: 'graph', group: 'contracts', en: ['API operation', 'API operations'], ru: ['Операция API', 'Операции API'], describe: ['An operation an OpenAPI or gRPC contract declares.', 'Операция, которую объявляет контракт OpenAPI или gRPC.'] },
  { name: 'code.contract', template: 'contract.liquid', source: 'graph', group: 'contracts', en: ['Contract', 'Contracts'], ru: ['Контракт', 'Контракты'], describe: ['An OpenAPI, gRPC or AsyncAPI file that fixes an interface.', 'Файл OpenAPI, gRPC или AsyncAPI, который фиксирует интерфейс.'] },
  { name: 'code.channel', template: 'item-plain.liquid', source: 'graph', group: 'contracts', en: ['Event channel', 'Event channels'], ru: ['Канал событий', 'Каналы событий'], describe: ['A topic or queue that services publish to and read from.', 'Топик или очередь, в которую сервисы пишут и из которой читают.'] },
  { name: 'code.message', template: 'item-plain.liquid', source: 'graph', group: 'contracts', en: ['Event', 'Events'], ru: ['Событие', 'События'], describe: ['A kind of message sent over a channel.', 'Вид сообщения, которое передают по каналу.'] },
  { name: 'code.database', template: 'database.liquid', source: 'graph', group: 'data', en: ['Database', 'Databases'], ru: ['База данных', 'Базы данных'], describe: ['A database a service owns, with its tables and migrations.', 'База данных сервиса, её таблицы и миграции.'] },
  { name: 'code.table', template: 'table.liquid', source: 'graph', group: 'data', en: ['Table', 'Tables'], ru: ['Таблица', 'Таблицы'], describe: ['A table, its columns and indexes, and the code that reads and writes it.', 'Таблица, её столбцы и индексы, и код, который её читает и пишет.'] },
  { name: 'code.column', template: 'item-plain.liquid', source: 'graph', group: 'data', en: ['Column', 'Columns'], ru: ['Столбец', 'Столбцы'], describe: ['A column of a table with its type.', 'Столбец таблицы с его типом.'] },
  { name: 'code.index', template: 'item.liquid', source: 'graph', group: 'data', en: ['Index', 'Indexes'], ru: ['Индекс', 'Индексы'], describe: ['A database index.', 'Индекс базы данных.'] },
  { name: 'code.migration', template: 'item.liquid', source: 'graph', group: 'data', en: ['Migration', 'Migrations'], ru: ['Миграция', 'Миграции'], describe: ['A step that changes a database\'s schema, in the order they run.', 'Шаг, который меняет схему базы данных, в порядке выполнения.'] },
  { name: 'code.env-var', template: 'item.liquid', source: 'graph', group: 'operations.configuration', en: ['Environment variable', 'Environment variables'], ru: ['Переменная окружения', 'Переменные окружения'], describe: ['A setting the code reads from its environment, with where it is defined.', 'Настройка, которую код читает из окружения, и где она задана.'] },
  { name: 'code.env-definition', template: 'item.liquid', source: 'graph', group: 'operations.configuration', en: ['Variable definition', 'Variable definitions'], ru: ['Определение переменной', 'Определения переменных'], describe: ['A place that gives an environment variable a value.', 'Место, где переменной окружения задано значение.'] },
  { name: 'code.dependency', template: 'item.liquid', source: 'graph', group: 'operations.dependencies', en: ['Dependency', 'Dependencies'], ru: ['Зависимость', 'Зависимости'], describe: ['A library a service declares, with its version and where it is used.', 'Библиотека, которую объявляет сервис, её версия и где она используется.'] },
  { name: 'code.manifest', template: 'item.liquid', source: 'graph', group: 'operations.dependencies', en: ['Manifest', 'Manifests'], ru: ['Манифест', 'Манифесты'], describe: ['A package.json or go.mod file that declares dependencies.', 'Файл package.json или go.mod, который объявляет зависимости.'] },
  { name: 'code.lockfile', template: 'item.liquid', source: 'graph', group: 'operations.dependencies', en: ['Lock file', 'Lock files'], ru: ['Файл блокировки', 'Файлы блокировки'], describe: ['A file that pins the exact versions of the dependencies.', 'Файл, который закрепляет точные версии зависимостей.'] },
  { name: 'code.dockerfile', template: 'item.liquid', source: 'graph', group: 'operations.build-deploy', en: ['Dockerfile', 'Dockerfiles'], ru: ['Dockerfile', 'Dockerfile'], describe: ['A recipe that builds a container image.', 'Рецепт сборки образа контейнера.'] },
  { name: 'code.image', template: 'item-plain.liquid', source: 'graph', group: 'operations.build-deploy', en: ['Image', 'Images'], ru: ['Образ', 'Образы'], describe: ['A container image a deployment runs.', 'Образ контейнера, который запускает развёртывание.'] },
  { name: 'code.compose-service', template: 'item.liquid', source: 'graph', group: 'operations.build-deploy', en: ['Compose service', 'Compose services'], ru: ['Сервис compose', 'Сервисы compose'], describe: ['A service of a docker-compose file, with its ports and dependencies.', 'Сервис файла docker-compose, его порты и зависимости.'] },
  { name: 'code.k8s-deployment', template: 'item.liquid', source: 'graph', group: 'operations.build-deploy', en: ['Kubernetes deployment', 'Kubernetes deployments'], ru: ['Развёртывание Kubernetes', 'Развёртывания Kubernetes'], describe: ['A Kubernetes Deployment: image, replicas and probes.', 'Развёртывание Kubernetes: образ, число реплик и проверки.'] },
  { name: 'code.k8s-service', template: 'item.liquid', source: 'graph', group: 'operations.build-deploy', en: ['Kubernetes service', 'Kubernetes services'], ru: ['Сервис Kubernetes', 'Сервисы Kubernetes'], describe: ['A Kubernetes Service that routes traffic to pods.', 'Сервис Kubernetes, который направляет трафик на поды.'] },
  { name: 'code.ci-workflow', template: 'item.liquid', source: 'graph', group: 'operations.ci-cd', en: ['CI workflow', 'CI workflows'], ru: ['Процесс CI', 'Процессы CI'], describe: ['A continuous-integration workflow file.', 'Файл процесса непрерывной интеграции.'] },
  { name: 'code.ci-job', template: 'item.liquid', source: 'graph', group: 'operations.ci-cd', en: ['CI job', 'CI jobs'], ru: ['Задача CI', 'Задачи CI'], describe: ['A job of a CI workflow and the steps it runs.', 'Задача процесса CI и шаги, которые она выполняет.'] },
  { name: 'code.make-target', template: 'item.liquid', source: 'graph', group: 'operations.build-deploy', en: ['Make target', 'Make targets'], ru: ['Цель make', 'Цели make'], describe: ['A target of a Makefile and the commands it runs.', 'Цель Makefile и команды, которые она выполняет.'] },
  { name: 'code.process', template: 'item-plain.liquid', source: 'graph', group: 'operations.runtime', en: ['Process', 'Processes'], ru: ['Процесс', 'Процессы'], describe: ['A program the system starts, and the port it listens on.', 'Программа, которую запускает система, и порт, который она слушает.'] },
  { name: 'code.port', template: 'item-plain.liquid', source: 'graph', group: 'operations.runtime', en: ['Port', 'Ports'], ru: ['Порт', 'Порты'], describe: ['A network port a service listens on or publishes.', 'Сетевой порт, который сервис слушает или публикует.'] },
  { name: 'code.health-endpoint', template: 'item.liquid', source: 'graph', group: 'operations.runtime', en: ['Health endpoint', 'Health endpoints'], ru: ['Проверка здоровья', 'Проверки здоровья'], describe: ['The route that tells whether a service is alive.', 'Маршрут, по которому видно, жив ли сервис.'] },
  { name: 'code.metric', template: 'item.liquid', source: 'graph', group: 'operations.runtime', en: ['Metric', 'Metrics'], ru: ['Метрика', 'Метрики'], describe: ['A declared counter, gauge or histogram and the code that updates it.', 'Объявленный счётчик, шкала или гистограмма и код, который меняет её.'] },
  { name: 'code.broker', template: 'item.liquid', source: 'graph', group: 'operations.runtime', en: ['Message broker', 'Message brokers'], ru: ['Брокер сообщений', 'Брокеры сообщений'], describe: ['A broker declared by deployment or connection settings.', 'Брокер, объявленный в развёртывании или настройках подключения.'] },
  { name: 'code.probe', template: 'item.liquid', source: 'graph', group: 'operations.runtime', en: ['Probe', 'Probes'], ru: ['Проба', 'Пробы'], describe: ['One configured readiness, liveness or startup probe.', 'Настроенная проба готовности, работоспособности или запуска.'] },
  { name: 'code.healthcheck', template: 'item.liquid', source: 'graph', group: 'operations.runtime', en: ['Healthcheck', 'Healthchecks'], ru: ['Проверка состояния', 'Проверки состояния'], describe: ['A configured compose healthcheck command and its timing.', 'Команда проверки состояния compose и её интервалы.'] },
  { name: 'code.document-section', template: 'item.liquid', source: 'graph', group: 'code.structure', en: ['Document section', 'Document sections'], ru: ['Раздел документа', 'Разделы документов'], describe: ['A heading and its section declared in a repository document.', 'Заголовок и его раздел в документе репозитория.'] },
  { name: 'code.metrics-endpoint', template: 'item.liquid', source: 'graph', group: 'operations.runtime', en: ['Metrics endpoint', 'Metrics endpoints'], ru: ['Выдача метрик', 'Выдачи метрик'], describe: ['The route that serves a service\'s metrics.', 'Маршрут, по которому сервис отдаёт метрики.'] },
  { name: 'code.logger', template: 'item.liquid', source: 'graph', group: 'operations.runtime', en: ['Logger', 'Loggers'], ru: ['Логгер', 'Логгеры'], describe: ['Where a service sets up its logging.', 'Место, где сервис настраивает журнал.'] },
  { name: 'code.newcomer-command', template: 'item.liquid', source: 'graph', group: 'operations.newcomer', en: ['Setup command', 'Setup commands'], ru: ['Команда запуска', 'Команды запуска'], describe: ['A command the README tells a newcomer to run.', 'Команда, которую README велит выполнить новичку.'] },
  { name: 'code.newcomer-prerequisites', template: 'item.liquid', source: 'graph', group: 'operations.newcomer', en: ['Prerequisites', 'Prerequisites'], ru: ['Что нужно установить', 'Что нужно установить'], describe: ['The tools the README says a newcomer needs.', 'Инструменты, которые по README нужны новичку.'] },
  { name: 'code.newcomer-failure', template: 'item.liquid', source: 'graph', group: 'operations.newcomer', en: ['Known failure', 'Known failures'], ru: ['Известная ошибка', 'Известные ошибки'], describe: ['A failure the README names, with its fix.', 'Ошибка, которую называет README, и как её исправить.'] },
  { name: 'code.test-case', template: 'item.liquid', source: 'graph', group: 'tests', en: ['Test case', 'Test cases'], ru: ['Тест', 'Тесты'], describe: ['A test, and the code it exercises.', 'Тест и код, который он проверяет.'] },
  { name: 'code.commit', template: 'commit.liquid', source: 'graph', group: 'history', origin: 'history', en: ['Commit', 'Commits'], ru: ['Коммит', 'Коммиты'], describe: ['A change in the repository\'s history, with its author and the files it touched.', 'Изменение в истории репозитория, его автор и затронутые файлы.'] },
  { name: 'code.author', template: 'author.liquid', source: 'graph', group: 'history', origin: 'history', en: ['Author', 'Authors'], ru: ['Автор', 'Авторы'], describe: ['A person who made commits.', 'Человек, который делал коммиты.'] },
  { name: 'code.snapshot', template: 'item-plain.liquid', source: 'graph', group: 'history', origin: 'history', en: ['Repository landmark', 'Repository landmarks'], ru: ['Ориентир репозитория', 'Ориентиры репозитория'], describe: ['A repository landmark read from Git, with its commit and the files held by that tree.', 'Ориентир из Git с его коммитом и файлами этого дерева репозитория.'] },
  { name: 'code.task', template: 'history-task.liquid', source: 'graph', group: 'history', origin: 'history', en: ['Task', 'Tasks'], ru: ['Задача', 'Задачи'], describe: ['A tracker task that commit messages name.', 'Задача трекера, которую называют сообщения коммитов.'] },
];

export const yamlText = (text: string): string => JSON.stringify(text);

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
  { id: 'wiki.unread-passage', predicate: 'wiki', kind: 'unread-passage', sonar: 'code-smell', severity: 'minor', section: 'wiki', action: 'task', enabled: true, label: { en: 'Passage not read', ru: 'Фрагмент не прочитан' } },
  { id: 'wiki.unplaced', predicate: 'wiki', kind: 'unplaced', sonar: 'code-smell', severity: 'minor', section: 'wiki', action: 'task', enabled: true, label: { en: 'Unplaced finding', ru: 'Находка без места' } },
  { id: 'wiki.manifest', predicate: 'wiki', kind: 'manifest', sonar: 'bug', severity: 'major', section: 'wiki', action: 'task', enabled: true, label: { en: 'Manifest finding', ru: 'Замечание к манифесту' } },
];

/** The starter rules as the settings the page reads: the same data the manifest text is written from. */
export function starterProblemSettings(): ProblemSettings {
  const rules = Object.fromEntries(STARTER_PROBLEM_RULES.map(({ id, ...setting }) => [id, setting] as const));
  return { rules, thresholds: { ...DEFAULT_THRESHOLDS } };
}

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
    "# opens on the menu by itself (`open: true`); a group without a parent is a top-level group.",
    "groups:",
    ...GROUPS.map((group) => `  ${group.name}: { en: ${yamlText(group.en)}, ru: ${yamlText(group.ru)}${group.parent === undefined ? '' : `, parent: ${group.parent}`}${group.open === undefined ? '' : ', open: true'} }`),
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
    "kinds:",
  ];
  for (const kind of STARTER_KINDS) lines.push(...kindLines(kind));
  return `${lines.join('\n')}\n`;
}

/** The declaration of one starter kind, as lines of the manifest; `group: false` leaves the group out (a manifest that declares none). */
export function kindLines(kind: StarterKind, options: { group?: boolean } = {}): string[] {
  const lines: string[] = [];
  {
    lines.push(`  ${kind.name}:`);
    lines.push(`    template: templates/${kind.template}`);
    lines.push(`    source: ${kind.source}`);
    if (options.group !== false) lines.push(`    group: ${kind.group}`);
    if (kind.origin !== undefined) lines.push(`    origin: ${kind.origin}`);
    for (const extra of kind.extra ?? []) lines.push(`    ${extra}`);
    lines.push('    labels:');
    lines.push(`      en: { one: ${yamlText(kind.en[0])}, many: ${yamlText(kind.en[1])} }`);
    lines.push(`      ru: { one: ${yamlText(kind.ru[0])}, many: ${yamlText(kind.ru[1])} }`);
    lines.push('    description:');
    lines.push(`      en: ${yamlText(kind.describe[0])}`);
    lines.push(`      ru: ${yamlText(kind.describe[1])}`);
  }
  return lines;
}

const KINDS = kindsManifest();

export const STARTER_FILES: readonly StarterFile[] = [
  { path: 'madarch/kinds.yaml', content: KINDS },
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
    const parsed = parseDocument(`kinds:\n${kindLines(kind, { group: document.hasIn(['groups', kind.group]) }).join('\n')}\n`).getIn(['kinds', kind.name]) as { toJSON(): unknown };
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
