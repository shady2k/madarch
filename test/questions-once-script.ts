/** The answer key's eight open.* cases, authored explicitly for the scripted ACP reader walk. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOOP_QUESTIONS, paymentsRefreshed, questionSlug, type LoopQuestion } from './loop-agent-script.js';
import { localizedScript, agentScript, TEXT, type ScriptLanguage } from './knowledge-agent-script.js';
import { ROOT } from './knowledge-fixture.js';

export const ONCE_QUESTIONS: readonly LoopQuestion[] = [
  {
    item: 'open.contradiction', unit: 'ordering', type: 'contradiction',
    text: {
      en: { title: 'Which README promises should govern discount, tax and retention?', question: 'The README promises ten percent off every order, five percent tax and indefinite retention; requirements and code apply caller discounts, eight percent tax and ninety-day expiry. Which of these conflicting promises should govern?', why: 'The published promises and implemented rules give a shopper different outcomes.', claims: ['The README promises ten percent off every order, five percent tax and indefinite retention.', 'The requirements and code apply a caller discount, eight percent tax and expiry of unshipped orders after ninety days.'] },
      ru: { title: 'Какие обещания README должны действовать для скидки, налога и хранения?', question: 'README обещает десять процентов скидки каждому заказу, пять процентов налога и бессрочное хранение; требования и код применяют скидку вызывающего, восемь процентов налога и удаление через девяносто дней. Какие из противоречащих обещаний должны действовать?', why: 'Опубликованные обещания и реализованные правила дают покупателю разный результат.', claims: ['README обещает десять процентов скидки каждому заказу, пять процентов налога и бессрочное хранение.', 'Требования и код применяют скидку вызывающего, восемь процентов налога и удаляют неотправленные заказы через девяносто дней.'] },
    },
    sides: [['doc:README.md#what-it-does'], ['doc:docs/requirements.md#br-1', 'doc:docs/requirements.md#br-2', 'code.file:services/orders/internal/application/order_service.go']],
  },
  {
    item: 'open.behavior', unit: 'ordering', type: 'undocumented',
    text: {
      en: { title: 'Is the undocumented automatic expiry intended?', question: 'The retention job automatically purges unshipped orders after ninety days and no document describes that operation. Is this automatic operation intended?', why: 'Support needs to know whether the undocumented operation is intended.', claims: ['The retention worker runs the automatic expiry operation for unshipped orders.'] },
      ru: { title: 'Задумано ли недокументированное автоматическое удаление?', question: 'Задача хранения автоматически удаляет неотправленные заказы через девяносто дней, но ни один документ не описывает эту операцию. Задумана ли такая автоматическая операция?', why: 'Поддержке нужно знать, задумана ли недокументированная операция.', claims: ['Задача хранения запускает автоматическое удаление неотправленных заказов.'] },
    }, sides: [['code.file:services/orders/cmd/orders/retention.go']],
  },
  {
    item: 'open.assumption', unit: 'ordering', type: 'gap',
    text: {
      en: { title: 'Must the caller always supply a discount?', question: 'Should the caller supply a discount for every order, as the README assumes, or may an order omit it as the code and discount requirement allow?', why: 'This decides the caller obligation, not the numeric discount or tax promises.', claims: ['The checkout discount function applies the percentage the caller supplies.'] },
      ru: { title: 'Обязан ли вызывающий всегда передавать скидку?', question: 'Должен ли вызывающий передавать скидку для каждого заказа, как предполагает README, или заказ может быть без неё, как допускают код и требование о скидке?', why: 'Это решает обязанность вызывающего, а не числовые обещания скидки и налога.', claims: ['Функция скидки при оформлении применяет процент, который передал вызывающий.'] },
    }, sides: [['code.file:services/checkout/src/pricing.ts']],
  },
  { ...LOOP_QUESTIONS.find((question) => question.item === 'term.payment-token')!, item: 'open.term' },
  {
    item: 'open.unverifiable', unit: 'payments', type: 'gap',
    text: {
      en: { title: 'Who can verify the content behind the sign-in link?', question: 'The README points behind a sign-in page. Who can provide the content so its claims can be verified from evidence?', why: 'Claims in inaccessible content cannot be checked from the repository.', claims: ['The README links to a sign-in protected page for private details.'] },
      ru: { title: 'Кто может проверить содержимое за страницей входа?', question: 'README ведёт на страницу за входом. Кто может предоставить её содержимое, чтобы проверить утверждения по источникам?', why: 'Утверждения в недоступном содержимом нельзя проверить по репозиторию.', claims: ['README ссылается на страницу за входом для частных сведений.'] },
    }, sides: [['doc:README.md#what-it-does']],
  },
  {
    item: 'open.meaning', unit: 'ordering', type: 'gap',
    text: {
      en: { title: 'What happens to a captured payment when an unshipped order expires?', question: 'What does purging an unpaid or paid but unshipped order mean for the customer after ninety days; is a captured payment refunded?', why: 'The customer outcome of expiry is not defined by removing the order alone.', claims: ['The order domain purges expired orders that have not been shipped.'] },
      ru: { title: 'Что происходит со списанным платежом после удаления неотправленного заказа?', question: 'Что означает для покупателя удаление неоплаченного или оплаченного, но неотправленного заказа через девяносто дней; возвращается ли списанный платёж?', why: 'Удаление заказа само по себе не определяет результат для покупателя.', claims: ['Домен заказов удаляет просроченные заказы, которые не были отправлены.'] },
    }, sides: [['code.file:services/orders/internal/domain/order.go']],
  },
  {
    item: 'open.rationale', unit: 'ordering', type: 'gap',
    text: {
      en: { title: 'Why does the expiry period equal ninety days?', question: 'Why was exactly ninety days chosen for expiry of unshipped orders rather than another duration, when no decision record or comment gives the reason?', why: 'Changing the duration safely requires knowing its rationale.', claims: ['The order domain sets the expiry period to ninety days.'] },
      ru: { title: 'Почему срок удаления равен девяноста дням?', question: 'Почему для удаления неотправленных заказов выбраны именно девяносто дней, а не другой срок, если ни запись решения, ни комментарий не объясняет причину?', why: 'Для безопасного изменения срока нужно знать причину решения.', claims: ['Домен заказов задаёт срок удаления в девяносто дней.'] },
    }, sides: [['code.file:services/orders/internal/domain/order.go']],
  },
  {
    item: 'open.access', unit: 'payments', type: 'gap',
    text: {
      en: { title: 'Where are the actual private project documents?', question: 'The link labelled the project workspace leads to personal profile settings, not project documents. What is the correct document location and how can project readers get access?', why: 'Readers need a correct location and access, separate from verifying any content already obtained.', claims: ['The README labels a profile settings link as the project workspace.'] },
      ru: { title: 'Где находятся настоящие частные документы проекта?', question: 'Ссылка с подписью рабочего пространства проекта ведёт в личные настройки профиля, а не к документам проекта. Где правильное место документов и как читателю получить доступ?', why: 'Читателю нужно правильное место и доступ, отдельно от проверки уже полученного содержимого.', claims: ['README называет ссылку на настройки профиля рабочим пространством проекта.'] },
    }, sides: [['doc:README.md#what-it-does']],
  },
];
export const EXPECTED_FIRST_QUESTIONS = 8;
const KEY = JSON.parse(readFileSync(join(ROOT, 'examples/training-repository/answer-key.json'), 'utf8')) as { items: { id: string; expectedWikiStatement: string; location?: { path: string; symbol?: string; anchor?: string }; locations?: { path: string; symbol?: string; anchor?: string }[] }[] };
export const ONCE_KEY_MAPPING = ONCE_QUESTIONS.map((question) => ({ key: question.item, expected: KEY.items.find((item) => item.id === question.item), titles: { en: question.text.en.title, ru: question.text.ru.title }, grounds: question.sides.flat() }));

/** The owner fixture is authoritative. Refuse a missing/extra key or grounds that omit its named source file. */
export function validateOnceKey(): void {
  const file = join(ROOT, 'examples/training-repository/answer-key.json');
  const key = JSON.parse(readFileSync(file, 'utf8')) as { items: { id: string; location?: { path: string }; locations?: { path: string }[] }[] };
  const expected = key.items.filter((item) => item.id.startsWith('open.'));
  if (expected.length !== 8 || JSON.stringify(expected.map((item) => item.id).sort()) !== JSON.stringify(ONCE_QUESTIONS.map((question) => question.item).sort())) throw new Error(`${file}: authored questions must map exactly to the eight open.* answer-key cases`);
  for (const item of expected) {
    const original = KEY.items.find((record) => record.id === item.id)!;
    for (const location of original.locations ?? (original.location ? [original.location] : [])) {
      const path = join(ROOT, 'examples/training-repository/template', location.path);
      const source = readFileSync(path, 'utf8');
      if ((location.symbol && !source.includes(location.symbol)) || (location.anchor && !source.includes(location.anchor))) throw new Error(`${path}: source no longer contains exact answer-key symbol/anchor for ${item.id}`);
    }
    const authored = ONCE_QUESTIONS.find((question) => question.item === item.id)!;
    const paths = authored.sides.flat().map((ground) => ground.replace(/^code\.file:|^doc:/, '').replace(/#.*$/, ''));
    for (const location of item.locations ?? (item.location ? [item.location] : [])) if (!paths.includes(location.path)) throw new Error(`${file}: ${item.id} omits key ground ${location.path}`);
  }
}
const ask = (question: LoopQuestion, language: ScriptLanguage) => ({ call: {
  tool: 'ask_question', compareQuestions: ONCE_QUESTIONS.map((candidate) => ({ question: candidate.text[language].question, same: candidate.item === question.item, reason: candidate.item === question.item ? `Same authored decision ${question.item}.` : `Distinct authored decisions ${question.item} and ${candidate.item}; compare the requested outcome, not shared sources.` })),
  arguments: { type: question.type, title: question.text[language].title, question: question.text[language].question, why: question.text[language].why, sides: question.sides.map((grounds, index) => ({ claim: question.text[language].claims[index], grounds: [...grounds] })) },
} });
const localized = () => localizedScript().byPrompt.filter((entry) => entry.matches?.includes('Entity name:') || entry.matches?.includes('translating one extracted'));
export function onceFirstScript() {
  validateOnceKey();
  const base = agentScript();
  const byPrompt = base.byPrompt.map((entry) => {
    const language: ScriptLanguage = entry.matches.includes(TEXT.ru.orderingSummary) || entry.matches.includes(TEXT.ru.paymentsSummary) || entry.matches.includes('Russian') ? 'ru' : 'en';
    const unit = entry.matches.includes(TEXT[language].orderingSummary) ? 'ordering' : entry.matches.includes(TEXT[language].paymentsSummary) ? 'payments' : undefined;
    if (!unit) return entry;
    const steps: any[] = ONCE_QUESTIONS.filter((question) => question.unit === unit).map((question) => ask(question, language));
    const decision = ONCE_QUESTIONS.find((question) => question.item === 'open.contradiction')!;
    const paraphrase = language === 'ru' ? (unit === 'ordering' ? 'Какие из противоречащих обещаний магазина верны?' : 'Должен ли магазин соблюдать обещания README или реализованные правила?') : (unit === 'ordering' ? 'Which conflicting shop promises are correct?' : 'Should the shop follow its README promises or its implemented rules?');
    const proposal = ask(decision, language);
    steps.push({ call: { ...proposal.call, arguments: { ...proposal.call.arguments, title: paraphrase, question: paraphrase, ...(unit === 'payments' ? { type: 'gap', sides: [proposal.call.arguments.sides[1]!] } : {}) } } });
    const written = entry.steps.map((step) => {
      const call = (step as any).call;
      if (call?.tool !== 'write_page') return step;
      const markdown: string = call.arguments.markdown;
      const at = markdown.indexOf('\n[^1]:');
      const label = language === 'ru' ? 'вопрос' : 'question';
      const body = decision.sides.map((grounds, index) => `${decision.text[language].claims[index]}[^promise-${index}] [→ ${label}: ${decision.text[language].title}](madarch:question:${questionSlug(decision, language)})`).join('\n\n');
      const notes = decision.sides.map((grounds, index) => `[^promise-${index}]: ${grounds.map((ground) => `[source](madarch:${ground})`).join(', ')}`).join('\n');
      return { call: { ...call, arguments: { ...call.arguments, markdown: `${markdown.slice(0, at)}\n\n${body}${markdown.slice(at)}\n${notes}` } } };
    });
    return { ...entry, steps: [...steps, ...written] };
  });
  return { ...base, byPrompt: [...localized(), ...byPrompt] };
}
export function onceRefreshScript(language: ScriptLanguage) {
  const question = ONCE_QUESTIONS.find((candidate) => candidate.item === 'open.term')!;
  return { byPrompt: [{ matches: `(madarch:question:${questionSlug(question, language)})`, steps: [ask(question, language), { call: { tool: 'write_page', arguments: { markdown: paymentsRefreshed(language) } } }, { end: { stopReason: 'end_turn' } }] }], steps: [{ end: { stopReason: 'end_turn' } }] };
}
/** Refill asks only the kept answer again; removed unanswered decisions are not re-created by this fixture script. */
export function onceRefillScript(language: ScriptLanguage) {
  const base = agentScript();
  const question = ONCE_QUESTIONS.find((candidate) => candidate.item === 'open.term')!;
  const byPrompt = base.byPrompt.map((entry) => entry.matches.includes(TEXT[language].paymentsSummary) ? { ...entry, steps: [ask(question, language), { call: { tool: 'write_page', arguments: { markdown: paymentsRefreshed(language) } } }, { end: { stopReason: 'end_turn' } }] } : entry);
  return { ...base, byPrompt: [...localized(), ...byPrompt] };
}
export const onceQuestionIds = (language: ScriptLanguage): string[] => ONCE_QUESTIONS.map((question) => `question:${questionSlug(question, language)}`).sort();
