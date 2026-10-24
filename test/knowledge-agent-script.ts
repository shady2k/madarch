/**
 * The pages the fake ACP agent writes for the generated training repository
 * (madarch-m38l.3): the product page and the pages of its two domains, as a
 * script of `test/fixtures/acp-fake-agent`. Every ground is a fact of the
 * generated repository (the answer key's services and documents). The end to
 * end test and the screenshots walk both run the production agent path with
 * this script behind an adapter executable on the PATH.
 */
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
    orderingStatement: 'При оформлении заказа сервис заказов просит сервис платежей авторизовать карту на сумму заказа.',
    paymentsStatement: 'Платёж проходит через одного из двух провайдеров, которого выбирает конфигурация.',
  },
} as const;
export type ScriptLanguage = keyof typeof TEXT;

/** A document id as a page of the product repository, or of the one code repository the walk writes from. */
const documentGround = (ground: string, repo: string | undefined): string => (repo === undefined || !ground.startsWith('doc:') || ground.startsWith('doc:@') ? ground : `doc:@${repo}/${ground.slice('doc:'.length)}`);

/**
 * Where a page's ids and document grounds point: the product the walk fills (its id is `product:<name>`) and the code
 * repository its documents are read from (`training` when the walk fills a product over the training repository, whose
 * documents are not the product's own).
 */
export interface PagePlaces { product?: string; repo?: string }

export const productPage = (language: ScriptLanguage, places: PagePlaces = {}): string => {
  const t = TEXT[language];
  const uc = (rest: string): string => `madarch:${documentGround(`doc:${rest}`, places.repo)}`;
  return [
    '---', `id: ${places.product ?? 'product:training-shop'}`, 'kind: product', `title: ${t.productTitle}`, 'relates:', `  - ${ORDERS_SERVICE}`, `  - ${PAYMENTS_SERVICE}`, 'producer: agent', 'sources: [docs/vision.md, docs/requirements.md]', '---', '',
    `## ${t.whatItIs}`, '',
    `${t.intro}[^1]`, '',
    `## ${t.domains}`, '',
    `- [${t.ordering}](madarch:domain:ordering) ${t.orderingLine(ORDERS_SERVICE)}[^2]`,
    `- [${t.payments}](madarch:domain:payments) ${t.paymentsLine(PAYMENTS_SERVICE)}[^3]`, '',
    `[^1]: [orders](madarch:${ORDERS_SERVICE}), [payments](madarch:${PAYMENTS_SERVICE})`,
    `[^2]: [orders](madarch:${ORDERS_SERVICE}), [UC-1](${uc('docs/requirements.md#uc-1')})`,
    `[^3]: [payments](madarch:${PAYMENTS_SERVICE}), [UC-2](${uc('docs/requirements.md#uc-2')})`,
  ].join('\n');
};
export const domain = (language: ScriptLanguage, slug: 'ordering' | 'payments', service: string, grounds: string[], places: PagePlaces = {}): string => {
  const t = TEXT[language];
  return [
    '---', `id: domain:${slug}`, 'kind: domain', `title: ${t[slug]}`, 'relates:', `  - ${service}`, 'producer: agent', 'sources: [docs/requirements.md]', '---', '',
    `## ${t.how(slug)}`, '', `${slug === 'ordering' ? t.orderingStatement : t.paymentsStatement}[^1]`, '',
    `[^1]: ${grounds.map((ground) => `[${ground.replace(/^.*[:#/]/, '')}](madarch:${documentGround(ground, places.repo)})`).join(', ')}`,
  ].join('\n');
};

export const call = (markdown: string, domains?: unknown) => ({ call: { tool: 'write_page', arguments: domains === undefined ? { markdown } : { markdown, domains } } });

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
  'ADR-0001: Kafka is the broker': 'События заказов публикуются в Kafka, а не в очередь самого приложения.',
  'ADR-0002: The outbox table': 'Сервис заказов пишет сообщения в таблицу outbox в той же транзакции, что и изменение заказа, а отдельный процесс публикует их в Kafka.',
};

/** The statement of an entity the table does not name: Russian prose that keeps the entity's own name out of it. */
export const LOCALIZED_STATEMENT = 'Краткое изложение источника на русском языке.';

/**
 * The script of a wiki whose pages are Russian over the training repository's English documents: the
 * product page and its domains in Russian, and one Russian statement for every extracted document
 * entity the writer asks for. A prompt that names an entity is answered by its name alone, so a page
 * never falls back to another unit's text.
 */
export function localizedScript(delays: { product?: number; ordering?: number; payments?: number } = {}, places: PagePlaces = {}) {
  const base = agentScript(delays, places);
  const named = Object.entries(LOCALIZED_STATEMENTS).map(([title, statement]) => ({ matches: `Entity name: ${title}\n`, steps: [localizedCall(statement), { end: { stopReason: 'end_turn' } }] }));
  return {
    byPrompt: [
      ...named,
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
      { matches: `The product unit declared this domain: ${t.orderingSummary}`, steps: [...wait(delays.ordering), call(domain(language, 'ordering', ORDERS_SERVICE, ['doc:docs/requirements.md#uc-2', PAY], places)), { end: { stopReason: 'end_turn' } }] },
      { matches: `The product unit declared this domain: ${t.paymentsSummary}`, steps: [...wait(delays.payments), call(domain(language, 'payments', PAYMENTS_SERVICE, [FACTORY], places)), { end: { stopReason: 'end_turn' } }] },
    ];
  };
  const productSteps = (language: ScriptLanguage) => {
    const t = TEXT[language];
    return [
      ...wait(delays.product),
      call(productPage(language, places), [
        { slug: 'ordering', title: t.ordering, summary: t.orderingSummary, evidence: [ORDERS_SERVICE, documentGround('doc:docs/requirements.md#uc-1', places.repo)] },
        { slug: 'payments', title: t.payments, summary: t.paymentsSummary, evidence: [PAYMENTS_SERVICE, documentGround('doc:docs/requirements.md#uc-2', places.repo)] },
      ]),
      { end: { stopReason: 'end_turn' } },
    ];
  };
  return {
    byPrompt: [
      ...unit('en'),
      ...unit('ru'),
      { matches: 'and its title, in Russian', steps: productSteps('ru') },
    ],
    steps: productSteps('en'),
  };
}
