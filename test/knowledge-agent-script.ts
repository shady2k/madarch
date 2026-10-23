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

export const productPage = (language: ScriptLanguage): string => {
  const t = TEXT[language];
  return [
    '---', 'id: product:training-shop', 'kind: product', `title: ${t.productTitle}`, 'relates:', `  - ${ORDERS_SERVICE}`, `  - ${PAYMENTS_SERVICE}`, 'producer: agent', 'sources: [docs/vision.md, docs/requirements.md]', '---', '',
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
export const domain = (language: ScriptLanguage, slug: 'ordering' | 'payments', service: string, grounds: string[]): string => {
  const t = TEXT[language];
  return [
    '---', `id: domain:${slug}`, 'kind: domain', `title: ${t[slug]}`, 'relates:', `  - ${service}`, 'producer: agent', 'sources: [docs/requirements.md]', '---', '',
    `## ${t.how(slug)}`, '', `${slug === 'ordering' ? t.orderingStatement : t.paymentsStatement}[^1]`, '',
    `[^1]: ${grounds.map((ground) => `[${ground.replace(/^.*[:#/]/, '')}](madarch:${ground})`).join(', ')}`,
  ].join('\n');
};

export const call = (markdown: string, domains?: unknown) => ({ call: { tool: 'write_page', arguments: domains === undefined ? { markdown } : { markdown, domains } } });
/**
 * `delays` holds the milliseconds each unit takes before it writes, so a walk can see a unit in progress. The agent
 * writes in the language its prompt asks for: English, or Russian when the prompt says "in Russian".
 */
export function agentScript(delays: { product?: number; ordering?: number; payments?: number } = {}) {
  const wait = (ms: number | undefined): { sleep: number }[] => (ms === undefined ? [] : [{ sleep: ms }]);
  const unit = (language: ScriptLanguage) => {
    const t = TEXT[language];
    return [
      { matches: `The product unit declared this domain: ${t.orderingSummary}`, steps: [...wait(delays.ordering), call(domain(language, 'ordering', ORDERS_SERVICE, ['doc:docs/requirements.md#uc-2', PAY])), { end: { stopReason: 'end_turn' } }] },
      { matches: `The product unit declared this domain: ${t.paymentsSummary}`, steps: [...wait(delays.payments), call(domain(language, 'payments', PAYMENTS_SERVICE, [FACTORY])), { end: { stopReason: 'end_turn' } }] },
    ];
  };
  const productSteps = (language: ScriptLanguage) => {
    const t = TEXT[language];
    return [
      ...wait(delays.product),
      call(productPage(language), [
        { slug: 'ordering', title: t.ordering, summary: t.orderingSummary, evidence: [ORDERS_SERVICE, 'doc:docs/requirements.md#uc-1'] },
        { slug: 'payments', title: t.payments, summary: t.paymentsSummary, evidence: [PAYMENTS_SERVICE, 'doc:docs/requirements.md#uc-2'] },
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
