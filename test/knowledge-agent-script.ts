/**
 * The pages the fake ACP agent writes for the generated training repository
 * (madarch-m38l.3): the product page and the pages of its two domains, as a
 * script of `test/fixtures/acp-fake-agent`. Every ground is a fact of the
 * generated repository (the answer key's services and documents). The end to
 * end test and the screenshots walk both run the production agent path with
 * this script behind an adapter executable on the PATH.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readDocEntities } from '../src/knowledge/doc-entities.js';
import { readKinds } from '../src/knowledge/kinds.js';
import { FACTORY, PAY, PAYMENTS_SERVICE } from './knowledge-fixture.js';

export const ORDERS_SERVICE = 'code.service:orders';

/** What the fake agent says, per language: the headings and the statements it grounds. The grounds are the same facts in both. */
export const TEXT = {
  en: {
    orderingSummary: 'Ordering is what the orders service does when a shopper places an order.',
    paymentsSummary: 'Payments is what the payments service does when it charges a card.',
    productTitle: 'Training shop', whatItIs: 'What the product is', domains: 'Domains',
    intro: 'The training shop takes orders from shoppers and charges their cards through a payments service.',
    ordering: 'Ordering', payments: 'Payments',
    orderingLine: (service: string) => `is implemented by the [orders service](madarch:${service}).`,
    paymentsLine: (service: string) => `is implemented by the [payments service](madarch:${service}).`,
    how: (slug: string) => `How ${slug} works`,
    orderingParticipant: 'A shopper places an order and waits for it to be paid.',
    paymentsParticipant: 'A shopper pays for an order with a card.',
    orderingSystem: (service: string) => `The orders service takes the order in and keeps it.`,
    paymentsSystem: (service: string) => `The payments service charges the card through a provider.`,
    orderingStatement: "Checkout asks payments to authorize the card for the order's total.",
    paymentsStatement: 'Payments are charged through one of two providers chosen by configuration.',
  },
  ru: {
    orderingSummary: 'Заказы: то, что делает сервис заказов, когда покупатель оформляет заказ.',
    paymentsSummary: 'Платежи: то, что делает сервис платежей, когда списывает деньги с карты.',
    productTitle: 'Учебный магазин', whatItIs: 'Что это за продукт', domains: 'Домены',
    intro: 'Учебный магазин принимает заказы покупателей и списывает деньги с их карт через сервис платежей.',
    ordering: 'Заказы', payments: 'Платежи',
    orderingLine: (service: string) => `реализует [сервис заказов](madarch:${service}).`,
    paymentsLine: (service: string) => `реализует [сервис платежей](madarch:${service}).`,
    how: (slug: string) => `Как работают ${slug === 'ordering' ? 'заказы' : 'платежи'}`,
    orderingParticipant: 'Покупатель оформляет заказ и ждёт его оплаты.',
    paymentsParticipant: 'Покупатель оплачивает заказ картой.',
    orderingSystem: (service: string) => 'Сервис заказов принимает заказ и хранит его.',
    paymentsSystem: (service: string) => 'Сервис платежей списывает деньги с карты через провайдера.',
    orderingStatement: 'При оформлении заказа сервис заказов просит сервис платежей авторизовать карту на сумму заказа.',
    paymentsStatement: 'Платёж проходит через одного из двух провайдеров, которого выбирает конфигурация.',
  },
} as const;
export type ScriptLanguage = keyof typeof TEXT;

/**
 * Where a page's id points: the product the walk fills, whose id is `product:<name>`. A document ground keeps the path the
 * document has in the code repository (`docs/requirements.md`), which the writer reads and the reader resolves to the one
 * repository's document.
 */
export interface PagePlaces { product?: string }

export const productPage = (language: ScriptLanguage, places: PagePlaces = {}): string => {
  const t = TEXT[language];
  return [
    '---', `id: ${places.product ?? 'product:training-shop'}`, 'kind: product', `title: ${t.productTitle}`, 'relates:', `  - ${ORDERS_SERVICE}`, `  - ${PAYMENTS_SERVICE}`, 'producer: agent', 'sources: [docs/vision.md, docs/requirements.md]', '---', '',
    `## ${t.whatItIs}`, '',
    `${t.intro}[^1]`, '',
    `## ${t.domains}`, '',
    `- [${t.ordering}](madarch:domain:ordering) ${t.orderingLine(ORDERS_SERVICE)}[^2]`,
    `- [${t.payments}](madarch:domain:payments) ${t.paymentsLine(PAYMENTS_SERVICE)}[^3]`, '',
    `[^1]: [orders](madarch:${ORDERS_SERVICE}), [payments](madarch:${PAYMENTS_SERVICE})`,
    `[^2]: [orders](madarch:${ORDERS_SERVICE}), [UC-1](madarch:doc:docs/requirements.md#uc-1)`,
    `[^3]: [payments](madarch:${PAYMENTS_SERVICE}), [UC-2](madarch:doc:docs/requirements.md#uc-2)`,
  ].join('\n');
};
/**
 * The fields of a domain page, as the domain unit answers them (`src/writer/domain-page.ts`, madarch-ztyq.6): the
 * business first — who takes part, how it goes — and the places of the code in "developer". The grounds are split by
 * what they are: a document section or a service stands in the business part, and a route, a symbol, a table or a
 * channel is a place of the developer section, of the field its kind belongs to.
 */
export const domainFields = (language: ScriptLanguage, slug: 'ordering' | 'payments', service: string, grounds: string[], statement?: string): Record<string, unknown> => {
  const t = TEXT[language];
  const place = (kind: 'routes' | 'functions' | 'tables' | 'events', target: string): Record<string, unknown> => ({ target });
  const developer: Record<string, unknown> = {};
  for (const ground of grounds) {
    const field = ground.startsWith('code.route:') ? 'routes' : ground.startsWith('code.symbol:') ? 'functions' : ground.startsWith('code.table:') ? 'tables' : ground.startsWith('code.channel:') ? 'events' : undefined;
    if (field === undefined) continue;
    developer[field] = [...((developer[field] as Record<string, unknown>[] | undefined) ?? []), place(field, ground)];
  }
  const business = grounds.filter((ground) => !ground.startsWith('code.') || ground.startsWith('code.service:'));
  const documents = business.filter((ground) => ground.startsWith('doc:'));
  // `service` is the graph key itself (`code.service:orders`), as every caller gives it: the participants and the
  // scenario stand on it when the documents name nothing, and it is the page's relates with the developer's places.
  const services = [...new Set([service, ...business.filter((ground) => ground.startsWith('code.service:'))])];
  const step = statement ?? (slug === 'ordering' ? t.orderingStatement : t.paymentsStatement);
  return {
    title: t[slug],
    participants: [
      { text: slug === 'ordering' ? t.orderingParticipant : t.paymentsParticipant, grounds: documents.length === 0 ? services : [documents[0]!] },
      { text: slug === 'ordering' ? t.orderingSystem(service) : t.paymentsSystem(service), grounds: [service] },
    ],
    mainScenario: [{ text: step, grounds: business.length === 0 ? services : business }],
    rules: [],
    whatCanGoWrong: [],
    openPoints: [],
    developer: { ...developer, notes: [] },
  };
};

export const call = (markdown: string, domains?: unknown) => ({ call: { tool: 'write_page', arguments: domains === undefined ? { markdown } : { markdown, domains } } });

/** The call a domain unit's prompt asks for: the fields of its page, which the core writes. */
export const fieldsCall = (fields: unknown) => ({ call: { tool: 'write_page', arguments: { fields } } });

/** The call a localized-source unit's prompt asks for: the one statement it writes, in the wiki's language. */
export const localizedCall = (statement: string) => ({ call: { tool: 'write_localized_source', arguments: { statement } } });

/**
 * The Russian statement the scripted agent writes for each extracted document entity of the training
 * repository (madarch-m38l.18): the entity's name stays exactly as the source writes it, and the
 * statement says in Russian what the source section says. Nothing here is a quotation: the writer keeps
 * the original wording beside the statement, under «В источнике».
 */
export const LOCALIZED_STATEMENTS: Readonly<Record<string, string>> = {
  // docs/glossary.md
  Order: 'Одна покупка: её позиции, цены и статус.',
  Outbox: 'Таблица, в которой сервис заказов хранит сообщения, которые опубликует.',
  'Idempotency key': 'Значение, которое выбирает вызывающий, чтобы повтор запроса не повторял его результат.',
  CardToken: 'Ссылка на карту в хранилище карт; сервисы никогда не видят номер карты.',
  PaymentToken: 'Подтверждение, которое провайдер возвращает, когда списал деньги.',
  Capture: 'Момент, когда деньги списываются с карты.',
  'Zero-rated': 'Товар, который продаётся без налога с продаж.',
  // docs/requirements.md
  'UC-1 Place order': 'Покупатель с активной сессией отправляет корзину; заказ сохраняется со статусом pending_payment, позициями, скидкой, налогом и суммой, а повторная отправка с тем же идентификатором запроса возвращает первый заказ.',
  'UC-2 Pay': 'При оформлении заказа сервис платежей авторизует карту на сумму заказа; успешный платёж подтверждает заказ, а отклонённый отменяет его, и покупателю объясняют причину.',
  'UC-3 Refund': 'Поддержка возвращает деньги за списанный платёж; возврат, который доводит сумму возвратов до списанной суммы, переводит заказ в статус refunded.',
  'UC-4 Apply promotion': 'Покупатель вводит код, и скидка, которую он даёт, вычитается из заказа до того, как запрашивается платёж.',
  'BR-1 Discount': 'Скидка — это процент, который выбирает вызывающий сервис заказов; он вычитается из каждой позиции заказа, а заказы применяют полученный процент и не выбирают его сами.',
  'BR-2 Tax': 'Налог с продаж — 8% от каждой позиции после скидки, округлённые до ближайшего цента; позиции без налога налогом не облагаются.',
  'BR-3 One charge per key': 'Оплата с уже использованным ключом идемпотентности возвращает первый платёж, и карта никогда не списывается дважды.',
  'BR-4 Refunds': 'Вернуть можно только списанный платёж, на положительную сумму, в течение 30 дней после списания и не больше списанной суммы.',
  'BR-5 Promotion cap': 'Акция никогда не вычитает больше, чем составляет сумма позиций.',
  // docs/adr
  'ADR-0001 Kafka is the broker': 'События заказов публикуются в Kafka, а не в очередь самого приложения.',
  'ADR-0002 Events leave through a transactional outbox': 'Сервис заказов пишет сообщения в таблицу outbox в той же транзакции, что и изменение заказа, а отдельный процесс публикует их в Kafka.',
};

/**
 * What this scripted agent writes for a document entity it holds no written Russian rendering of: the source's own words,
 * kept whole in an inline code span under the Russian lead that says where they stand. A scripted agent translates
 * nothing, so it quotes the section rather than inventing a sentence about it, and the same section always gives the same
 * statement. A section that holds an inline code span of its own cannot be quoted inside one (a span ends at its next
 * backtick, and the language reader would then count the English prose), so there the statement says where the section
 * stands and that no translation is given — never a fact the document does not hold.
 */
export function derivedStatement(entity: { text: string; line: number; endLine: number }, label: string): string {
  const lines = entity.line === entity.endLine ? `строка ${entity.line}` : `строки ${entity.line}–${entity.endLine}`;
  const words = entity.text.replace(/\s+/g, ' ').trim();
  return words === '' || words.includes('`')
    ? `Перевод не приводится: ${label}, ${lines} в источнике.`
    : `Перевод не приводится; слова источника, ${lines}: \`${words}\``;
}

/**
 * The statement for a document entity the script was not built for — one whose title `LOCALIZED_STATEMENTS` does not
 * name and that `localizableEntities()` did not list. It says no translation is given, so a unit is answered rather than
 * refused with an empty statement, and nothing about the section is invented.
 */
export const LOCALIZED_STATEMENT = 'Перевод не приводится: раздел изложен в источнике.';

/** One document entity the wiki offers for a localized statement, and the statement this scripted agent writes for it. */
export interface LocalizableEntity {
  readonly title: string;
  readonly statement: string;
}

/**
 * The document entities a product's wiki offers as localized sources, read the way the fill reads them — the product's
 * own manifest over the code repository's Markdown documents — each with the statement `derivedStatement()` writes. A
 * script built from this answers every entity the unit offers; adding a document to the repository adds its entry, with
 * nothing to keep in step by hand (madarch-ztyq.3).
 */
export function localizableEntities(productFolder: string, repository: string, repoName = 'training-shop'): LocalizableEntity[] {
  const kinds = readKinds(productFolder);
  if (!kinds.present) return [];
  const sources = markdownUnder(repository).map((path) => ({ repo: repoName, path, text: readFileSync(join(repository, path), 'utf8') }));
  return readDocEntities(sources, kinds.manifest).entities.map((entity) => ({
    title: entity.title,
    statement: derivedStatement(entity, kinds.manifest.kinds.get(entity.kind)?.labels?.['ru']?.one ?? 'Раздел документа'),
  }));
}

/** The Markdown documents under a folder, `/`-separated and in code point order. */
function markdownUnder(folder: string, root = folder): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (name === '.git' || name === 'node_modules') return [];
    if (statSync(path).isDirectory()) return markdownUnder(path, root);
    return /\.(md|markdown)$/i.test(name) ? [path.slice(root.length + 1).split('\\').join('/')] : [];
  }).sort();
}

/**
 * The script of a wiki whose pages are Russian over the training repository's English documents: the
 * product page and its domains in Russian, and one Russian statement for every extracted document
 * entity the writer asks for. A prompt that names an entity is answered by its name alone, so a page
 * never falls back to another unit's text; `entities` (from `localizableEntities()`) answers for every
 * entity the product's documents hold, and an entity neither names is answered with the plain note
 * that no translation is given, so no unit is ever refused for an empty statement.
 */
export function localizedScript(options: { entities?: readonly LocalizableEntity[]; delays?: { product?: number; ordering?: number; payments?: number }; places?: PagePlaces } = {}) {
  const base = agentScript(options.delays ?? {}, options.places ?? {});
  const named = Object.entries(LOCALIZED_STATEMENTS).map(([title, statement]) => ({ matches: `Entity name: ${title}\n`, steps: [localizedCall(statement), { end: { stopReason: 'end_turn' } }] }));
  const derived = (options.entities ?? [])
    .filter((entity) => LOCALIZED_STATEMENTS[entity.title] === undefined)
    .map((entity) => ({ matches: `Entity name: ${entity.title}\n`, steps: [localizedCall(entity.statement), { end: { stopReason: 'end_turn' } }] }));
  return {
    byPrompt: [
      ...named,
      ...derived,
      { matches: 'You are translating one extracted document entity', steps: [localizedCall(LOCALIZED_STATEMENT), { end: { stopReason: 'end_turn' } }] },
      ...base.byPrompt,
    ],
    steps: base.steps,
  };
}
/**
 * `delays` holds the milliseconds each unit takes before it writes, so a walk can see a unit in progress. The agent
 * writes in the language its prompt asks for: English, or Russian when the prompt says "in Russian".
 */
export function agentScript(delays: { product?: number; ordering?: number; payments?: number } = {}, places: PagePlaces = {}) {
  const wait = (ms: number | undefined): { sleep: number }[] => (ms === undefined ? [] : [{ sleep: ms }]);
  const unit = (language: ScriptLanguage) => {
    const t = TEXT[language];
    return [
      { matches: `The product unit declared this domain: ${t.orderingSummary}`, steps: [...wait(delays.ordering), fieldsCall(domainFields(language, 'ordering', ORDERS_SERVICE, ['doc:docs/requirements.md#uc-2', PAY])), { end: { stopReason: 'end_turn' } }] },
      { matches: `The product unit declared this domain: ${t.paymentsSummary}`, steps: [...wait(delays.payments), fieldsCall(domainFields(language, 'payments', PAYMENTS_SERVICE, [FACTORY])), { end: { stopReason: 'end_turn' } }] },
    ];
  };
  const productSteps = (language: ScriptLanguage) => {
    const t = TEXT[language];
    return [
      ...wait(delays.product),
      call(productPage(language, places), [
        { slug: 'ordering', title: t.ordering, summary: t.orderingSummary, evidence: [ORDERS_SERVICE, 'doc:docs/requirements.md#uc-1'] },
        { slug: 'payments', title: t.payments, summary: t.paymentsSummary, evidence: [PAYMENTS_SERVICE, 'doc:docs/requirements.md#uc-2'] },
      ]),
      { end: { stopReason: 'end_turn' } },
    ];
  };
  return {
    byPrompt: [
      { matches: 'Write the administrator-guide in ', steps: [{ guide: 'write' as const }, { end: { stopReason: 'end_turn' } }] },
      { matches: 'Write the user-guide in ', steps: [{ guide: 'write' as const }, { end: { stopReason: 'end_turn' } }] },
      { matches: 'Judge this proposed procedure step against the exact pinned source and graph facts.', steps: [{ guide: 'verify' as const }, { end: { stopReason: 'end_turn' } }] },
      ...unit('en'),
      ...unit('ru'),
      { matches: 'and its title, in Russian', steps: productSteps('ru') },
    ],
    steps: productSteps('en'),
  };
}
