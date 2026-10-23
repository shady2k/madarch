import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { parseDocument } from 'yaml';
import { KINDS_FILE } from './kinds.js';

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

/** A block line of a template: `:::name{title="..." title-ru="..." ...}`, the title in both interface languages. */
function block(name: string, en: string, ru: string, params = ''): string {
  return `:::${name}{title="${en}" title-ru="${ru}"${params === '' ? '' : ` ${params}`}}`;
}

/** The neighbourhood block of a page. */
const G = (en: string, ru: string): string => block('graph', en, ru);

const SECTION = {
  details: block('properties', 'Details', 'Сведения'),
  source: block('source', 'Source', 'Исходный текст'),
  relations: block('related', 'Relations', 'Связи'),
  pagesAbout: (what: string, ruWhat: string): string => block('related', `Pages about ${what}`, `Страницы о ${ruWhat}`, 'relation="relates"'),
};

const PRODUCT = `:::body
${block('system', 'The system', 'Система')}
${block('treemap', 'Files by size and change', 'Файлы по размеру и изменчивости')}
${block('related', 'Relates to', 'Связано с', 'relation="relates"')}
`;

const DOMAIN = `:::body
${block('sequence', 'End-to-end chain', 'Сквозная цепочка', 'scenario="{{title}}"')}
${G('Around this page','Вокруг этой страницы')}
${block('related', 'Implemented by', 'Реализуют', 'relation="relates"')}
`;

const SERVICE = `A {{language}} service. Frameworks: {{frameworks}}. Infrastructure: {{infrastructure}}. Tests: {{testFramework}}.

${G('Around this service','Вокруг этого сервиса')}
${block('modules', 'Modules', 'Модули')}
${block('treemap', 'Files by size and change', 'Файлы по размеру и изменчивости')}
${block('related', 'Files', 'Файлы', 'relation="code.contains" depth=3 kind="code.file" limit=60')}
${block('related', 'Modules', 'Модули', 'relation="code.contains" depth=2 kind="code.module" limit=60')}
${SECTION.pagesAbout('this service', 'этом сервисе')}
`;

const FILE = `{{path}}

${block('source', 'Source', 'Исходный текст')}
${G('Around this file','Вокруг этого файла')}
${block('related', 'Declares', 'Объявляет', 'relation="code.contains" direction="out" kind="code.symbol" limit=60')}
${block('related', 'Imports', 'Импортирует', 'relation="code.imports" direction="out"')}
${block('related', 'Imported by', 'Импортируют', 'relation="code.imports" direction="in"')}
${block('related', 'Contained in', 'Входит в', 'relation="code.contains" direction="in"')}
${SECTION.pagesAbout('this file', 'этом файле')}
`;

const SYMBOL = `{{symbolKind}} in {{path}}

${block('source', 'Source', 'Исходный текст')}
${block('callers', 'Callers', 'Кто вызывает')}
${block('callees', 'Calls', 'Что вызывает')}
${G('Around this function','Вокруг этой функции')}
${block('sequence', 'End-to-end chain', 'Сквозная цепочка', 'scenario="{{label}}"')}
${block('related', 'Tests and types', 'Тесты и типы', 'relation="code.tests,code.implements,code.inherits"')}
${SECTION.pagesAbout('this function', 'этой функции')}
`;

const PACKAGE = `${SECTION.details}
${G('Around this','Вокруг этого')}
${block('related', 'Modules', 'Модули', 'relation="code.contains" direction="out" kind="code.module" limit=60')}
${block('related', 'Files', 'Файлы', 'relation="code.contains" depth=3 kind="code.file" limit=80')}
${block('related', 'Relations', 'Связи', 'relation="code.manifest-of" direction="in"')}
${SECTION.pagesAbout('this package', 'этом пакете')}
`;

const MODULE = `${SECTION.details}
${G('Around this','Вокруг этого')}
${block('related', 'Files', 'Файлы', 'relation="code.contains" depth=2 kind="code.file" limit=80')}
${block('related', 'Symbols', 'Символы', 'relation="code.contains" depth=3 kind="code.symbol" limit=60')}
${block('related', 'Depends on', 'Зависит от', 'relation="code.depends-on" direction="out"')}
${block('related', 'Depended on by', 'Зависят от него', 'relation="code.depends-on" direction="in"')}
${block('related', 'Contained in', 'Входит в', 'relation="code.contains" direction="in"')}
${SECTION.pagesAbout('this module', 'этом модуле')}
`;

/** Entities that carry a place in a file: the details, the lines, the relations. */
const ITEM = `${SECTION.details}
${G('Around this','Вокруг этого')}
${SECTION.source}
${SECTION.relations}
${SECTION.pagesAbout('this', 'нём')}
`;

/** Entities with no place of their own in a file: the details and the relations. */
const ITEM_PLAIN = `${SECTION.details}
${G('Around this','Вокруг этого')}
${SECTION.relations}
${SECTION.pagesAbout('this', 'нём')}
`;

const DATABASE = `${SECTION.details}
${G('Around this','Вокруг этого')}
${block('children', 'Tables', 'Таблицы', 'kind="code.table" prefix="code.table:{{label}}/" relation="code.contains"')}
${block('children', 'Migrations', 'Миграции', 'kind="code.migration" prefix="code.migration:{{label}}/" relation="code.contains"')}
${block('er', 'Tables and their links', 'Таблицы и связи между ними', 'limit=12')}
${SECTION.relations}
${SECTION.pagesAbout('this database', 'этой базе данных')}
`;

const TABLE = `${SECTION.details}
${G('Around this','Вокруг этого')}
${SECTION.source}
${block('children', 'Columns', 'Столбцы', 'kind="code.column" prefix="{{key}}/" relation="code.contains" limit=200')}
${block('children', 'Indexes', 'Индексы', 'kind="code.index" prefix="code.index:{{keyrest}}/" relation="code.contains"')}
${block('er', 'The table and its links', 'Таблица и её связи')}
${SECTION.relations}
${SECTION.pagesAbout('this table', 'этой таблице')}
`;

/** A route: its neighbourhood and the chain from it to the tables, the other services and the topics. */
const ROUTE = `${SECTION.details}
${G('Around this route','Вокруг этого маршрута')}
${block('sequence', 'End-to-end chain', 'Сквозная цепочка', 'scenario="{{label}}"')}
${SECTION.source}
${SECTION.relations}
${SECTION.pagesAbout('this route', 'этом маршруте')}
`;

const ENTITY_TEXT = `:::body
${block('stated', 'Stated in', 'Где описано')}
${block('implementedby', 'Implemented by', 'Чем реализовано')}
${block('linkedfrom', 'Linked from', 'Ссылаются на него')}
`;

const TERM = `${block('term', 'Definition', 'Определение')}
${block('stated', 'Stated in', 'Где описано')}
${block('linkedfrom', 'Linked from', 'Ссылаются на него')}
`;

/** A task: the commits that name it, each with its day, its author and its message. */
const TASK = `${SECTION.details}
${block('history', 'Commits', 'Коммиты')}
${G('Around this','Вокруг этого')}
${SECTION.relations}
${SECTION.pagesAbout('this task', 'этой задаче')}
`;

/** A commit: the files it changed, with the lines it added and removed and the symbols they declare. */
const COMMIT = `${SECTION.details}
${block('history', 'Files changed', 'Изменённые файлы')}
${G('Around this commit','Вокруг этого коммита')}
${SECTION.relations}
${SECTION.pagesAbout('this commit', 'этом коммите')}
`;

/** An author: their commits, and the files and modules their work touches most. */
const AUTHOR = `${SECTION.details}
${block('history', 'Commits and files', 'Коммиты и файлы')}
${G('Around this author','Вокруг этого автора')}
${SECTION.relations}
${SECTION.pagesAbout('this author', 'этом авторе')}
`;


/** A contract: its definition in its own format, the members it declares, and where it stands. */
const CONTRACT = `${SECTION.details}
${block('definition', 'Definition', 'Определение')}
${G('Around this contract','Вокруг этого контракта')}
${SECTION.source}
${SECTION.relations}
${SECTION.pagesAbout('this contract', 'этом контракте')}
`;


/** An operation: what it is, where its code stands, the contract that declares it and its chain. */
const OPERATION = `${SECTION.details}
${G('Around this operation','Вокруг этой операции')}
${SECTION.source}
${block('related', 'Declared by', 'Объявлена в', 'relation="code.declares" direction="in"')}
${block('related', 'Served by', 'Обслуживается', 'relation="code.serves" direction="in"')}
${SECTION.relations}
${SECTION.pagesAbout('this operation', 'этой операции')}
`;

/** The shape each template file has; the kinds name the file. */
export const TEMPLATES: Readonly<Record<string, string>> = {
  'product.md': PRODUCT,
  'domain.md': DOMAIN,
  'service.md': SERVICE,
  'package.md': PACKAGE,
  'module.md': MODULE,
  'file.md': FILE,
  'symbol.md': SYMBOL,
  'route.md': ROUTE,
  'item.md': ITEM,
  'item-plain.md': ITEM_PLAIN,
  'contract.md': CONTRACT,
  'operation.md': OPERATION,
  'task.md': TASK,
  'commit.md': COMMIT,
  'author.md': AUTHOR,
  'database.md': DATABASE,
  'table.md': TABLE,
  'entity-text.md': ENTITY_TEXT,
  'term.md': TERM,
  'question.md': ':::body\n',
  'correction.md': ':::body\n',
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

export const GROUPS: readonly { name: string; en: string; ru: string }[] = [
  { name: 'product', en: 'Product knowledge', ru: 'Знания о продукте' },
  { name: 'code', en: 'Code', ru: 'Код' },
  { name: 'contracts', en: 'Contracts', ru: 'Контракты' },
  { name: 'data', en: 'Data', ru: 'Данные' },
  { name: 'operations', en: 'Operations', ru: 'Эксплуатация' },
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
  { name: 'product', template: 'product.md', source: 'markdown', group: 'product', en: ['Product', 'Products'], ru: ['Продукт', 'Продукты'], describe: ['What the product is, for whom, and its architecture: the home page the agent writes.', 'Что это за продукт, для кого и как устроен: главная страница, которую пишет агент.'], extra: ['file: docs/product.md'] },
  { name: 'domain', template: 'domain.md', source: 'markdown', group: 'product', en: ['Domain', 'Domains'], ru: ['Домен', 'Домены'], describe: ['A part of the business the product serves, such as payment or ordering: how it works and what implements it.', 'Часть бизнеса, которую обслуживает продукт, например оплата или заказы: как она работает и что её реализует.'], extra: ['folder: docs/domains'] },
  { name: 'question', template: 'question.md', source: 'markdown', group: 'product', origin: 'agent', en: ['Question', 'Questions'], ru: ['Вопрос', 'Вопросы'], describe: ['Something the agent could not settle from the code and the documents; a person answers it.', 'То, что агент не смог решить по коду и документам; отвечает человек.'], extra: ['folder: docs/questions'] },
  { name: 'correction', template: 'correction.md', source: 'markdown', group: 'product', origin: 'person', en: ['Correction', 'Corrections'], ru: ['Поправка', 'Поправки'], describe: ['A person\'s note that a statement is wrong, and why; the agent takes it into account at the next refresh.', 'Заметка человека о том, что утверждение неверно, и почему; агент учтёт её при следующем обновлении.'], extra: ['folder: docs/corrections'] },
  { name: 'doc.use-case', template: 'entity-text.md', source: 'document', group: 'product', origin: 'person', en: ['Use case', 'Use cases'], ru: ['Сценарий', 'Сценарии'], describe: ['A way a person uses the product (UC-1, UC-2 ...), as the documents state it.', 'Способ, которым человек пользуется продуктом (UC-1, UC-2 ...), как его описывают документы.'], extra: ['identifier: UC'] },
  { name: 'doc.rule', template: 'entity-text.md', source: 'document', group: 'product', origin: 'person', en: ['Business rule', 'Business rules'], ru: ['Бизнес-правило', 'Бизнес-правила'], describe: ['A rule the product keeps (BR-1, BR-2 ...), with the code that implements it.', 'Правило, которое соблюдает продукт (BR-1, BR-2 ...), и код, который его реализует.'], extra: ['identifier: BR'] },
  { name: 'doc.decision', template: 'entity-text.md', source: 'document', group: 'product', origin: 'person', en: ['Decision', 'Decisions'], ru: ['Решение', 'Решения'], describe: ['An architecture decision record (ADR-0001 ...): what was decided and why.', 'Запись об архитектурном решении (ADR-0001 ...): что решили и почему.'], extra: ['identifier: ADR'] },
  { name: 'doc.requirement', template: 'entity-text.md', source: 'document', group: 'product', origin: 'person', en: ['Requirement', 'Requirements'], ru: ['Требование', 'Требования'], describe: ['Another identified item of the documents: a requirement, a story, a feature (FR-1, NFR-2, REQ-3, US-4 ...).', 'Другой пронумерованный пункт документов: требование, история, возможность (FR-1, NFR-2, REQ-3, US-4 ...).'], extra: ['identifier: [FR, NFR, REQ, PR, US]'] },
  { name: 'doc.term', template: 'term.md', source: 'document', group: 'product', origin: 'person', en: ['Glossary term', 'Glossary terms'], ru: ['Термин', 'Термины'], describe: ['A term of the product\'s language, defined in a glossary.', 'Слово из языка продукта с определением из глоссария.'], extra: ['terms: ["**/glossary*.md"]'] },
  { name: 'code.service', template: 'service.md', source: 'graph', group: 'code', en: ['Service', 'Services'], ru: ['Сервис', 'Сервисы'], describe: ['A deployable part of the system, read from its manifest.', 'Развёртываемая часть системы, прочитанная из её манифеста.'], extra: ['relations:', '  - { type: code.contains, to: "code.package:{span.path|dirname}" }'] },
  { name: 'code.package', template: 'package.md', source: 'graph', group: 'code', en: ['Package', 'Packages'], ru: ['Пакет', 'Пакеты'], describe: ['The folder a service\'s manifest sits in, with its tests and frameworks.', 'Папка с манифестом сервиса, его тесты и фреймворки.'] },
  { name: 'code.module', template: 'module.md', source: 'graph', group: 'code', en: ['Module', 'Modules'], ru: ['Модуль', 'Модули'], describe: ['A folder of code with a purpose of its own, with the modules it depends on.', 'Папка кода со своим назначением и модули, от которых она зависит.'] },
  { name: 'code.file', template: 'file.md', source: 'graph', group: 'code', en: ['File', 'Files'], ru: ['Файл', 'Файлы'], describe: ['A file of a code repository.', 'Файл репозитория кода.'] },
  { name: 'code.symbol', template: 'symbol.md', source: 'graph', group: 'code', en: ['Symbol', 'Symbols'], ru: ['Символ', 'Символы'], describe: ['A function, class or constant, with its callers and callees.', 'Функция, класс или константа, кто её вызывает и что она вызывает.'] },
  { name: 'code.entry-point', template: 'item.md', source: 'graph', group: 'code', en: ['Entry point', 'Entry points'], ru: ['Точка входа', 'Точки входа'], describe: ['Where a process of the system starts running.', 'Место, где начинает работать процесс системы.'] },
  { name: 'code.cycle', template: 'item-plain.md', source: 'graph', group: 'code', en: ['Dependency cycle', 'Dependency cycles'], ru: ['Цикл зависимостей', 'Циклы зависимостей'], describe: ['Files or modules that import one another in a ring.', 'Файлы или модули, которые импортируют друг друга по кругу.'] },
  { name: 'code.facet', template: 'item-plain.md', source: 'graph', group: 'code', en: ['File facet', 'File facets'], ru: ['Срез файла', 'Срезы файлов'], describe: ['What the code reader found out about a file: its role and language.', 'Что читатель кода выяснил о файле: его роль и язык.'] },
  { name: 'code.input', template: 'item.md', source: 'graph', group: 'code', en: ['Input', 'Inputs'], ru: ['Входные данные', 'Входные данные'], describe: ['A value that enters the code from outside, such as a query parameter.', 'Значение, которое попадает в код снаружи, например параметр запроса.'] },
  { name: 'code.sql-build', template: 'item-plain.md', source: 'graph', group: 'code', en: ['SQL build', 'SQL builds'], ru: ['Сборка SQL', 'Сборки SQL'], describe: ['A function that builds SQL text by joining strings.', 'Функция, которая собирает текст SQL склейкой строк.'] },
  { name: 'code.sql-sink', template: 'item.md', source: 'graph', group: 'code', en: ['SQL sink', 'SQL sinks'], ru: ['Выполнение SQL', 'Места выполнения SQL'], describe: ['A call that runs SQL text as it is.', 'Вызов, который выполняет текст SQL как есть.'] },
  { name: 'code.route', template: 'route.md', source: 'graph', group: 'contracts', en: ['HTTP route', 'HTTP routes'], ru: ['HTTP-маршрут', 'HTTP-маршруты'], describe: ['An HTTP route a service serves, read from its code.', 'HTTP-маршрут, который обслуживает сервис, прочитанный из кода.'] },
  { name: 'code.operation', template: 'operation.md', source: 'graph', group: 'contracts', en: ['API operation', 'API operations'], ru: ['Операция API', 'Операции API'], describe: ['An operation an OpenAPI or gRPC contract declares.', 'Операция, которую объявляет контракт OpenAPI или gRPC.'] },
  { name: 'code.contract', template: 'contract.md', source: 'graph', group: 'contracts', en: ['Contract', 'Contracts'], ru: ['Контракт', 'Контракты'], describe: ['An OpenAPI, gRPC or AsyncAPI file that fixes an interface.', 'Файл OpenAPI, gRPC или AsyncAPI, который фиксирует интерфейс.'] },
  { name: 'code.channel', template: 'item-plain.md', source: 'graph', group: 'contracts', en: ['Event channel', 'Event channels'], ru: ['Канал событий', 'Каналы событий'], describe: ['A topic or queue that services publish to and read from.', 'Топик или очередь, в которую сервисы пишут и из которой читают.'] },
  { name: 'code.message', template: 'item-plain.md', source: 'graph', group: 'contracts', en: ['Event', 'Events'], ru: ['Событие', 'События'], describe: ['A kind of message sent over a channel.', 'Вид сообщения, которое передают по каналу.'] },
  { name: 'code.database', template: 'database.md', source: 'graph', group: 'data', en: ['Database', 'Databases'], ru: ['База данных', 'Базы данных'], describe: ['A database a service owns, with its tables and migrations.', 'База данных сервиса, её таблицы и миграции.'] },
  { name: 'code.table', template: 'table.md', source: 'graph', group: 'data', en: ['Table', 'Tables'], ru: ['Таблица', 'Таблицы'], describe: ['A table, its columns and indexes, and the code that reads and writes it.', 'Таблица, её столбцы и индексы, и код, который её читает и пишет.'] },
  { name: 'code.column', template: 'item-plain.md', source: 'graph', group: 'data', en: ['Column', 'Columns'], ru: ['Столбец', 'Столбцы'], describe: ['A column of a table with its type.', 'Столбец таблицы с его типом.'] },
  { name: 'code.index', template: 'item.md', source: 'graph', group: 'data', en: ['Index', 'Indexes'], ru: ['Индекс', 'Индексы'], describe: ['A database index.', 'Индекс базы данных.'] },
  { name: 'code.migration', template: 'item.md', source: 'graph', group: 'data', en: ['Migration', 'Migrations'], ru: ['Миграция', 'Миграции'], describe: ['A step that changes a database\'s schema, in the order they run.', 'Шаг, который меняет схему базы данных, в порядке выполнения.'] },
  { name: 'code.env-var', template: 'item.md', source: 'graph', group: 'operations', en: ['Environment variable', 'Environment variables'], ru: ['Переменная окружения', 'Переменные окружения'], describe: ['A setting the code reads from its environment, with where it is defined.', 'Настройка, которую код читает из окружения, и где она задана.'] },
  { name: 'code.env-definition', template: 'item.md', source: 'graph', group: 'operations', en: ['Variable definition', 'Variable definitions'], ru: ['Определение переменной', 'Определения переменных'], describe: ['A place that gives an environment variable a value.', 'Место, где переменной окружения задано значение.'] },
  { name: 'code.dependency', template: 'item.md', source: 'graph', group: 'operations', en: ['Dependency', 'Dependencies'], ru: ['Зависимость', 'Зависимости'], describe: ['A library a service declares, with its version and where it is used.', 'Библиотека, которую объявляет сервис, её версия и где она используется.'] },
  { name: 'code.manifest', template: 'item.md', source: 'graph', group: 'operations', en: ['Manifest', 'Manifests'], ru: ['Манифест', 'Манифесты'], describe: ['A package.json or go.mod file that declares dependencies.', 'Файл package.json или go.mod, который объявляет зависимости.'] },
  { name: 'code.lockfile', template: 'item.md', source: 'graph', group: 'operations', en: ['Lock file', 'Lock files'], ru: ['Файл блокировки', 'Файлы блокировки'], describe: ['A file that pins the exact versions of the dependencies.', 'Файл, который закрепляет точные версии зависимостей.'] },
  { name: 'code.dockerfile', template: 'item.md', source: 'graph', group: 'operations', en: ['Dockerfile', 'Dockerfiles'], ru: ['Dockerfile', 'Dockerfile'], describe: ['A recipe that builds a container image.', 'Рецепт сборки образа контейнера.'] },
  { name: 'code.image', template: 'item-plain.md', source: 'graph', group: 'operations', en: ['Image', 'Images'], ru: ['Образ', 'Образы'], describe: ['A container image a deployment runs.', 'Образ контейнера, который запускает развёртывание.'] },
  { name: 'code.compose-service', template: 'item.md', source: 'graph', group: 'operations', en: ['Compose service', 'Compose services'], ru: ['Сервис compose', 'Сервисы compose'], describe: ['A service of a docker-compose file, with its ports and dependencies.', 'Сервис файла docker-compose, его порты и зависимости.'] },
  { name: 'code.k8s-deployment', template: 'item.md', source: 'graph', group: 'operations', en: ['Kubernetes deployment', 'Kubernetes deployments'], ru: ['Развёртывание Kubernetes', 'Развёртывания Kubernetes'], describe: ['A Kubernetes Deployment: image, replicas and probes.', 'Развёртывание Kubernetes: образ, число реплик и проверки.'] },
  { name: 'code.k8s-service', template: 'item.md', source: 'graph', group: 'operations', en: ['Kubernetes service', 'Kubernetes services'], ru: ['Сервис Kubernetes', 'Сервисы Kubernetes'], describe: ['A Kubernetes Service that routes traffic to pods.', 'Сервис Kubernetes, который направляет трафик на поды.'] },
  { name: 'code.ci-workflow', template: 'item.md', source: 'graph', group: 'operations', en: ['CI workflow', 'CI workflows'], ru: ['Процесс CI', 'Процессы CI'], describe: ['A continuous-integration workflow file.', 'Файл процесса непрерывной интеграции.'] },
  { name: 'code.ci-job', template: 'item.md', source: 'graph', group: 'operations', en: ['CI job', 'CI jobs'], ru: ['Задача CI', 'Задачи CI'], describe: ['A job of a CI workflow and the steps it runs.', 'Задача процесса CI и шаги, которые она выполняет.'] },
  { name: 'code.make-target', template: 'item.md', source: 'graph', group: 'operations', en: ['Make target', 'Make targets'], ru: ['Цель make', 'Цели make'], describe: ['A target of a Makefile and the commands it runs.', 'Цель Makefile и команды, которые она выполняет.'] },
  { name: 'code.process', template: 'item-plain.md', source: 'graph', group: 'operations', en: ['Process', 'Processes'], ru: ['Процесс', 'Процессы'], describe: ['A program the system starts, and the port it listens on.', 'Программа, которую запускает система, и порт, который она слушает.'] },
  { name: 'code.port', template: 'item-plain.md', source: 'graph', group: 'operations', en: ['Port', 'Ports'], ru: ['Порт', 'Порты'], describe: ['A network port a service listens on or publishes.', 'Сетевой порт, который сервис слушает или публикует.'] },
  { name: 'code.health-endpoint', template: 'item.md', source: 'graph', group: 'operations', en: ['Health endpoint', 'Health endpoints'], ru: ['Проверка здоровья', 'Проверки здоровья'], describe: ['The route that tells whether a service is alive.', 'Маршрут, по которому видно, жив ли сервис.'] },
  { name: 'code.metrics-endpoint', template: 'item.md', source: 'graph', group: 'operations', en: ['Metrics endpoint', 'Metrics endpoints'], ru: ['Выдача метрик', 'Выдачи метрик'], describe: ['The route that serves a service\'s metrics.', 'Маршрут, по которому сервис отдаёт метрики.'] },
  { name: 'code.logger', template: 'item.md', source: 'graph', group: 'operations', en: ['Logger', 'Loggers'], ru: ['Логгер', 'Логгеры'], describe: ['Where a service sets up its logging.', 'Место, где сервис настраивает журнал.'] },
  { name: 'code.newcomer-command', template: 'item.md', source: 'graph', group: 'operations', en: ['Setup command', 'Setup commands'], ru: ['Команда запуска', 'Команды запуска'], describe: ['A command the README tells a newcomer to run.', 'Команда, которую README велит выполнить новичку.'] },
  { name: 'code.newcomer-prerequisites', template: 'item.md', source: 'graph', group: 'operations', en: ['Prerequisites', 'Prerequisites'], ru: ['Что нужно установить', 'Что нужно установить'], describe: ['The tools the README says a newcomer needs.', 'Инструменты, которые по README нужны новичку.'] },
  { name: 'code.newcomer-failure', template: 'item.md', source: 'graph', group: 'operations', en: ['Known failure', 'Known failures'], ru: ['Известная ошибка', 'Известные ошибки'], describe: ['A failure the README names, with its fix.', 'Ошибка, которую называет README, и как её исправить.'] },
  { name: 'code.test-case', template: 'item.md', source: 'graph', group: 'tests', en: ['Test case', 'Test cases'], ru: ['Тест', 'Тесты'], describe: ['A test, and the code it exercises.', 'Тест и код, который он проверяет.'] },
  { name: 'code.commit', template: 'commit.md', source: 'graph', group: 'history', origin: 'history', en: ['Commit', 'Commits'], ru: ['Коммит', 'Коммиты'], describe: ['A change in the repository\'s history, with its author and the files it touched.', 'Изменение в истории репозитория, его автор и затронутые файлы.'] },
  { name: 'code.author', template: 'author.md', source: 'graph', group: 'history', origin: 'history', en: ['Author', 'Authors'], ru: ['Автор', 'Авторы'], describe: ['A person who made commits.', 'Человек, который делал коммиты.'] },
  { name: 'code.task', template: 'task.md', source: 'graph', group: 'history', origin: 'history', en: ['Task', 'Tasks'], ru: ['Задача', 'Задачи'], describe: ['A tracker task that commit messages name.', 'Задача трекера, которую называют сообщения коммитов.'] },
];

export const yamlText = (text: string): string => JSON.stringify(text);

/** The exclusion list of the manifest's `documents` section. */
export const DOCUMENT_EXCLUDES: readonly string[] = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '**/AGENTS.md', '**/CLAUDE.md', '**/GEMINI.md'];

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
    "#                     identifier (`identifier: UC` takes UC-1, UC-2 ...) or a bold term of a glossary (`terms: [...]`)",
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
    "groups:",
    ...GROUPS.map((group) => `  ${group.name}: { en: ${yamlText(group.en)}, ru: ${yamlText(group.ru)} }`),
    "documents:",
    "  exclude: [AGENTS.md, CLAUDE.md, GEMINI.md, \"**/AGENTS.md\", \"**/CLAUDE.md\", \"**/GEMINI.md\"]",
    "roles:",
    ...ROLES.map((role) => `  ${role.name}: { lead: [${role.lead.join(', ')}], open: [${role.open.join(', ')}] }`),
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
  const wanted = STARTER_KINDS.filter((kind) => kind.name === 'question' || kind.name === 'correction');
  let changed = false;
  for (const kind of wanted) {
    if (document.hasIn(['kinds', kind.name])) continue;
    // A group the manifest does not declare would make the kind a finding: the kind is then declared without one.
    const parsed = parseDocument(`kinds:\n${kindLines(kind, { group: document.hasIn(['groups', kind.group]) }).join('\n')}\n`).getIn(['kinds', kind.name]) as { toJSON(): unknown };
    document.setIn(['kinds', kind.name], document.createNode(parsed.toJSON()));
    changed = true;
  }
  for (const name of ['question.md', 'correction.md']) {
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
