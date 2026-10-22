/**
 * The pages the fake ACP agent writes for the generated training repository
 * (madarch-m38l.3): the product page and the pages of its two domains, as a
 * script of `test/fixtures/acp-fake-agent`. Every ground is a fact of the
 * generated repository (the answer key's services and documents). The end to
 * end test and the screenshots walk both run the production agent path with
 * this script behind an adapter executable on the PATH.
 */
import { FACTORY, PAY, PAYMENTS_SERVICE } from './knowledge-fixture.js';

const ORDERS_SERVICE = 'code.service:orders';

const ORDERING_SUMMARY = 'Ordering is what the orders service does when a shopper places an order.';
const PAYMENTS_SUMMARY = 'Payments is what the payments service does when it charges a card.';

const PRODUCT = [
  '---', 'id: product:training-shop', 'kind: product', 'title: Training shop', 'relates:', `  - ${ORDERS_SERVICE}`, `  - ${PAYMENTS_SERVICE}`, 'producer: agent', 'sources: [docs/vision.md, docs/requirements.md]', '---', '',
  '## What the product is', '',
  'The training shop takes orders from shoppers and charges their cards through a payments service.[^1]', '',
  '## Domains', '',
  `- [Ordering](madarch:domain:ordering) is implemented by the [orders service](madarch:${ORDERS_SERVICE}).[^2]`,
  `- [Payments](madarch:domain:payments) is implemented by the [payments service](madarch:${PAYMENTS_SERVICE}).[^3]`, '',
  `[^1]: [orders](madarch:${ORDERS_SERVICE}), [payments](madarch:${PAYMENTS_SERVICE})`,
  `[^2]: [orders](madarch:${ORDERS_SERVICE}), [UC-1](madarch:doc:docs/requirements.md#uc-1)`,
  `[^3]: [payments](madarch:${PAYMENTS_SERVICE}), [UC-2](madarch:doc:docs/requirements.md#uc-2)`,
].join('\n');
const domain = (slug: string, title: string, service: string, statement: string, grounds: string[]): string => [
  '---', `id: domain:${slug}`, 'kind: domain', `title: ${title}`, 'relates:', `  - ${service}`, 'producer: agent', 'sources: [docs/requirements.md]', '---', '',
  `## How ${slug} works`, '', `${statement}[^1]`, '',
  `[^1]: ${grounds.map((ground) => `[${ground.replace(/^.*[:#/]/, '')}](madarch:${ground})`).join(', ')}`,
].join('\n');

const call = (markdown: string, domains?: unknown) => ({ call: { tool: 'write_page', arguments: domains === undefined ? { markdown } : { markdown, domains } } });
/** `delays` holds the milliseconds each unit takes before it writes, so a walk can see a unit in progress. */
export function agentScript(delays: { product?: number; ordering?: number; payments?: number } = {}) {
  const wait = (ms: number | undefined): { sleep: number }[] => (ms === undefined ? [] : [{ sleep: ms }]);
  return {
  byPrompt: [
    { matches: `The product unit declared this domain: ${ORDERING_SUMMARY}`, steps: [...wait(delays.ordering), call(domain('ordering', 'Ordering', ORDERS_SERVICE, "Checkout asks payments to authorize the card for the order's total.", ['doc:docs/requirements.md#uc-2', PAY])), { end: { stopReason: 'end_turn' } }] },
    { matches: `The product unit declared this domain: ${PAYMENTS_SUMMARY}`, steps: [...wait(delays.payments), call(domain('payments', 'Payments', PAYMENTS_SERVICE, 'Payments are charged through one of two providers chosen by configuration.', [FACTORY])), { end: { stopReason: 'end_turn' } }] },
  ],
  steps: [
    ...wait(delays.product),
    call(PRODUCT, [
      { slug: 'ordering', title: 'Ordering', summary: ORDERING_SUMMARY, evidence: [ORDERS_SERVICE, 'doc:docs/requirements.md#uc-1'] },
      { slug: 'payments', title: 'Payments', summary: PAYMENTS_SUMMARY, evidence: [PAYMENTS_SERVICE, 'doc:docs/requirements.md#uc-2'] },
    ]),
    { end: { stopReason: 'end_turn' } },
  ],
  };
}

