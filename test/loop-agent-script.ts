/**
 * The questions the fake ACP agent asks the generated training repository
 * (madarch-m38l.7), as a script of `test/fixtures/acp-fake-agent`: for each
 * item the answer key lists where documents and code disagree (or where
 * nothing documents the code) it calls `ask_question` with the key's own
 * locations as grounds, then writes its pages as `agentScript` does. A second
 * script is the refresh that follows a person's answer: the payments page is
 * edited, keeping its sentence and adding one grounded in the answer. No model
 * runs; the grounds are facts of the generated repository.
 */
import { slugOf } from '../src/writer/names.js';
import { ORDERS_SERVICE, agentScript, domainFields, fieldsCall, productPage, TEXT, type ScriptLanguage } from './knowledge-agent-script.js';
import { FACTORY, PAY, PAYMENTS_SERVICE } from './knowledge-fixture.js';

export interface LoopQuestion {
  /** The answer key's item. */
  readonly item: string;
  readonly unit: 'ordering' | 'payments';
  readonly type: 'contradiction' | 'ambiguous-term' | 'undocumented' | 'gap';
  /** Per language: the title, the question, why it matters and the claim of each side; the grounds are the same in both. */
  readonly text: Record<ScriptLanguage, { title: string; question: string; why: string; claims: string[] }>;
  readonly sides: readonly (readonly string[])[];
}

export const LOOP_QUESTIONS: readonly LoopQuestion[] = [
  {
    item: 'contradiction.discount', unit: 'ordering', type: 'contradiction',
    text: {
      en: { title: 'Is the discount ten percent or what the caller passes?', question: 'The README says every order gets a ten percent discount; the requirements and the code say the caller of the orders service chooses the percentage. Which does the shop mean?', why: 'A shopper reading the README expects one number and may be charged another.', claims: ['The README says the service applies a ten percent discount to every order.', 'The requirements and the code apply the percentage the caller passes, and choose none.'] },
      ru: { title: 'Скидка десять процентов или та, что передал вызывающий?', question: 'В README сказано, что каждый заказ получает скидку десять процентов, а в требованиях и в коде процент выбирает вызывающий сервис заказов. Что имеет в виду магазин?', why: 'Покупатель, прочитавший README, ждёт одну цифру, а может получить другую.', claims: ['README говорит, что сервис применяет к каждому заказу скидку десять процентов.', 'Требования и код применяют процент, который передал вызывающий, и сами никакой не выбирают.'] },
    },
    sides: [['doc:README.md#what-it-does'], ['doc:docs/requirements.md#br-1', 'code.file\u003aservices/orders/internal/pricing/pricing.go', 'code.file\u003aservices/checkout/src/pricing.ts']],
  },
  {
    item: 'contradiction.tax', unit: 'ordering', type: 'contradiction',
    text: {
      en: { title: 'Is tax a flat five percent or eight?', question: 'The README says tax is a flat five percent; the requirements and the code use eight percent per line after its discount. Which rate is true?', why: 'The total a shopper sees depends on it.', claims: ['The README says tax is calculated at a flat five percent.', 'The requirements and the code use eight percent of each line after its discount.'] },
      ru: { title: 'Налог плоские пять процентов или восемь?', question: 'В README налог плоские пять процентов, а в требованиях и в коде восемь процентов с каждой строки после скидки. Какая ставка верна?', why: 'От этого зависит итог, который видит покупатель.', claims: ['README говорит, что налог считается по плоской ставке пять процентов.', 'Требования и код берут восемь процентов с каждой строки после скидки.'] },
    },
    sides: [['doc:README.md#what-it-does'], ['doc:docs/requirements.md#br-2', 'code.file\u003aservices/orders/internal/pricing/tax.go', 'code.file\u003aservices/checkout/src/pricing.ts']],
  },
  {
    item: 'contradiction.retention', unit: 'ordering', type: 'contradiction',
    text: {
      en: { title: 'Are orders kept forever or removed after ninety days?', question: 'Both READMEs say orders are kept indefinitely; the orders service has a job that removes orders that were not shipped after ninety days. Which one is true?', why: 'Support promises customers their orders stay available.', claims: ['The root README and the orders README say orders are retained indefinitely.', 'The orders service runs a retention job that removes unshipped orders after ninety days.'] },
      ru: { title: 'Заказы хранятся вечно или удаляются через девяносто дней?', question: 'В обоих README заказы хранятся бессрочно, а в сервисе заказов есть задача, которая удаляет неотправленные заказы через девяносто дней. Что верно?', why: 'Поддержка обещает клиентам, что заказы останутся доступны.', claims: ['Корневой README и README сервиса заказов говорят, что заказы хранятся бессрочно.', 'Сервис заказов запускает задачу, которая удаляет неотправленные заказы через девяносто дней.'] },
    },
    sides: [['doc:README.md#what-it-does', 'doc:services/orders/README.md#orders-service'], ['code.file\u003aservices/orders/internal/application/order_service.go']],
  },
  {
    item: 'behavior.retention-undocumented', unit: 'ordering', type: 'undocumented',
    text: {
      en: { title: 'Is the retention job meant to run every six hours?', question: 'The retention job wakes every six hours and no document describes it. Is that the intended schedule?', why: 'Operations cannot plan around a job nobody has described.', claims: ['The code starts the ninety-day expiry job and repeats it every six hours; no requirement, decision record or README mentions it.'] },
      ru: { title: 'Задача хранения должна запускаться каждые шесть часов?', question: 'Задача очистки просыпается каждые шесть часов, и ни один документ её не описывает. Таково задуманное расписание?', why: 'Эксплуатация не может планировать вокруг задачи, которую никто не описал.', claims: ['Код запускает задачу удаления через девяносто дней и повторяет её каждые шесть часов; ни требования, ни записи решений, ни README её не упоминают.'] },
    },
    sides: [['code.file\u003aservices/orders/cmd/orders/retention.go']],
  },
  {
    item: 'contradiction.outbox-timing', unit: 'ordering', type: 'contradiction',
    text: {
      en: { title: 'Do events reach Kafka at the commit or a second later?', question: 'The requirements say every change of an order reaches Kafka exactly when it is committed; the decision record and the code publish it a second or so later through a relay.', why: 'Consumers that rely on the first reading are surprised by the delay.', claims: ['The requirements say a change reaches Kafka exactly when the change is committed.', 'The decision record and the code write the message at the commit and publish it later, polling every second.'] },
      ru: { title: 'События попадают в Kafka в момент коммита или через секунду?', question: 'В требованиях каждое изменение заказа попадает в Kafka ровно в момент коммита, а запись решения и код публикуют его через секунду-другую через ретранслятор.', why: 'Потребители, рассчитывающие на первое чтение, удивляются задержке.', claims: ['Требования говорят, что изменение попадает в Kafka ровно в момент коммита.', 'Запись решения и код пишут сообщение при коммите и публикуют позже, опрашивая раз в секунду.'] },
    },
    sides: [['doc:docs/requirements.md#qualities'], ['doc:docs/adr/0002-outbox.md#adr-0002', 'code.file\u003aservices/orders/cmd/orders/main.go']],
  },
  {
    item: 'term.payment-token', unit: 'payments', type: 'ambiguous-term',
    text: {
      en: { title: 'Which token does "payment token" mean?', question: 'The architecture document passes a "payment token" from checkout to payments. The code has two tokens: CardToken, a vault reference to a card, and PaymentToken, the proof a provider returns when it captured money. Which one does the document mean?', why: 'The two are not interchangeable, and the glossary defines both.', claims: ['The architecture document says checkout sends the payment token with the amount to payments.', 'The glossary and the code distinguish CardToken from PaymentToken.'] },
      ru: { title: 'Какой токен имеется в виду под «платёжным токеном»?', question: 'В архитектуре «платёжный токен» уходит из `checkout` в `payments`. В коде два токена: `CardToken`, ссылка на карту в хранилище, и `PaymentToken`, подтверждение провайдера о списании. Какой из них имеется в виду?', why: 'Они не взаимозаменяемы, а глоссарий определяет оба.', claims: ['Документ по архитектуре говорит, что `checkout` отправляет платёжный токен вместе с суммой в `payments`.', 'Глоссарий и код различают `CardToken` и `PaymentToken`.'] },
    },
    sides: [['doc:docs/architecture.md#payment-flow'], ['doc:docs/glossary.md#cardtoken', 'doc:docs/glossary.md#paymenttoken', 'code.file\u003aservices/payments/src/domain/payment.ts']],
  },
  {
    item: 'payments.refund-no-resilience', unit: 'payments', type: 'gap',
    text: {
      en: { title: 'Is it intended that refunds have no timeout or retry?', question: 'A charge is protected by a timeout and a retry; a refund calls the provider directly. Is the asymmetry intended?', why: 'A slow provider can hold a refund request open and a transient failure is not retried.', claims: ['The payment service wraps the charge call in a timeout and a retry, and calls the provider directly for a refund.'] },
      ru: { title: 'Так задумано, что у возврата нет таймаута и повтора?', question: 'Списание защищено таймаутом и повтором, а возврат вызывает провайдера напрямую. Эта асимметрия задумана?', why: 'Медленный провайдер может держать запрос на возврат открытым, а временный сбой не повторяется.', claims: ['Сервис платежей оборачивает вызов списания в таймаут и повтор, а возврат вызывает провайдера напрямую.'] },
    },
    sides: [['code.file\u003aservices/payments/src/domain/payment-service.ts']],
  },
];

export const questionSlug = (question: LoopQuestion, language: ScriptLanguage): string => slugOf(question.text[language].title);

/** The sentences the sides of these contradictions stand on a page, each with its question link at its end. */
function sidesOf(questions: readonly LoopQuestion[], language: ScriptLanguage, replace?: { readonly item: string; readonly index: number; readonly text: string }): Record<string, unknown>[] {
  const label = language === 'ru' ? 'вопрос' : 'question';
  return questions.filter((held) => held.type === 'contradiction').flatMap((question) => question.sides.map((grounds, index) => ({
    text: `${replace !== undefined && question.item === replace.item && index === replace.index ? replace.text : question.text[language].claims[index]} [\u2192 ${label}: ${question.text[language].title}](madarch:question:${questionSlug(question, language)})`,
    grounds: [...grounds],
  })));
}

/**
 * The sentences one unit's contradictions stand on its page (madarch-m38l.13), in the order the unit asks them: a
 * caller that writes the page itself (a task run) uses this so its fields are the ones the first run wrote.
 */
export function contradictionSides(unit: 'ordering' | 'payments', language: ScriptLanguage, replace?: { readonly item: string; readonly index: number; readonly text: string }): Record<string, unknown>[] {
  return sidesOf(LOOP_QUESTIONS.filter((held) => held.unit === unit), language, replace);
}

/**
 * The fields keep what a contradiction's sides say: after the unit's own statements, each side of every
 * contradiction its unit asked stands as its own grounded sentence, with the question link at its end, as the
 * writer requires of a page whose contradiction is still open.
 */
function keepingSides(fields: Record<string, unknown>, questions: readonly LoopQuestion[], language: ScriptLanguage): Record<string, unknown> {
  const held = (fields['whatCanGoWrong'] as Record<string, unknown>[] | undefined) ?? [];
  return { ...fields, whatCanGoWrong: [...held, ...sidesOf(questions, language)] };
}

const ask = (question: LoopQuestion, language: ScriptLanguage) => {
  const text = question.text[language];
  return {
    call: {
      tool: 'ask_question',
      compareQuestions: LOOP_QUESTIONS.map((candidate) => ({
        question: candidate.text[language].question, same: candidate.item === question.item,
        reason: candidate.item === question.item ? 'The fixture asks the same decision in this answer-key item.' : `The fixture decisions differ: ${question.item} versus ${candidate.item}.`,
      })),
      arguments: {
        type: question.type, title: text.title, question: text.question, why: text.why,
        sides: question.sides.map((grounds, index) => ({ claim: text.claims[index], grounds: [...grounds] })),
      },
    },
  };
};

/**
 * The first run: the product page, then the two domain pages, each domain unit asking the questions of its items before
 * it writes. `delays` hold the milliseconds each unit takes, so a walk can see one in progress.
 */
export function firstRunScript(delays: { product?: number; ordering?: number; payments?: number } = {}) {
  const base = agentScript(delays);
  return {
    ...base,
    byPrompt: base.byPrompt.map((entry) => {
      const language: ScriptLanguage = entry.matches.includes(TEXT.ru.orderingSummary) || entry.matches.includes(TEXT.ru.paymentsSummary) || entry.matches.includes('Russian') ? 'ru' : 'en';
      const unit = entry.matches.includes(TEXT[language].orderingSummary) ? 'ordering' : entry.matches.includes(TEXT[language].paymentsSummary) ? 'payments' : undefined;
      if (unit === undefined) return entry;
      const asks = LOOP_QUESTIONS.filter((question) => question.unit === unit).map((question) => ask(question, language));
      if (unit === 'ordering') {
        const retention = LOOP_QUESTIONS.find((question) => question.item === 'contradiction.retention')!;
        if (retention === undefined) throw new Error('the training script needs its retention decision');
        const paraphrases = language === 'ru'
          ? ['Когда нужно удалять заказы?', 'Какой срок действует для хранения заказов?']
          : ['When must order data be removed?', 'Which retention duration applies to orders?'];
        for (const title of paraphrases) asks.push({ call: { ...ask(retention, language).call, arguments: { ...ask(retention, language).call.arguments, title, question: title } } });
      }
      // The delay, if any, stays first; the questions come before the page.
      const sleeps = entry.steps.filter((step) => 'sleep' in step);
      const mine = LOOP_QUESTIONS.filter((question) => question.unit === unit);
      const rest = entry.steps.filter((step) => !('sleep' in step)).map((step) => {
        const written = (step as { call?: { tool?: string; arguments?: { fields?: Record<string, unknown> } } }).call;
        return written?.tool === 'write_page' && written.arguments?.fields !== undefined
          ? { call: { ...written, arguments: { ...written.arguments, fields: keepingSides(written.arguments.fields, mine, language) } } }
          : step;
      });
      return { ...entry, steps: [...sleeps, ...asks, ...rest] };
    }),
  };
}

export const ANSWER_TEXT: Record<ScriptLanguage, string> = {
  en: 'Payment token in the documents means CardToken, the vault reference to a card. PaymentToken is the provider\'s proof of capture and has its own name.',
  ru: 'Платёжный токен в документах — это CardToken, ссылка на карту в хранилище. PaymentToken — подтверждение провайдера о списании, у него своё имя.',
};
const DECIDED: Record<ScriptLanguage, string> = {
  en: 'The payment token the documents mention is the CardToken, the vault reference to a card, as a person decided.',
  ru: 'Платёжный токен из документов — это CardToken, ссылка на карту в хранилище, как решил человек.',
};

/** The payments page after the answer to the payment-token question: its sentence kept, one added that stands on the answer. */
/**
 * The payments page after the answer to the payment-token question, as fields: the sentence the page carried stands
 * word for word, and one more stands on the answer the people gave — a rule of this domain, decided.
 */
export function paymentsRefreshed(language: ScriptLanguage): Record<string, unknown> {
  const question = LOOP_QUESTIONS.find((candidate) => candidate.item === 'term.payment-token')!;
  const slug = questionSlug(question, language);
  const fields = domainFields(language, 'payments', PAYMENTS_SERVICE, [FACTORY]);
  const rules = (fields['rules'] as Record<string, unknown>[]) ?? [];
  return {
    ...fields,
    rules: [...rules, { text: DECIDED[language], grounds: [`question:${slug}`, 'doc:docs/architecture.md#payment-flow'] }],
  };
}

/**
 * The refresh after the answer to the payment-token question: the payments unit is handed its page and the answer, keeps
 * its sentence word for word and adds one grounded in the answer. Any other unit that is asked gets nothing to write.
 */
export function refreshScript(language: ScriptLanguage, delay = 0) {
  const question = LOOP_QUESTIONS.find((candidate) => candidate.item === 'term.payment-token')!;
  const slug = questionSlug(question, language);
  return {
    byPrompt: [...agentScript().byPrompt.filter((entry) => entry.matches.startsWith('Write the ') || entry.matches.startsWith('Judge this proposed procedure step')), {
      matches: `(madarch:question:${slug})`,
      steps: [...(delay > 0 ? [{ sleep: delay }] : []), ask(question, language), fieldsCall(paymentsRefreshed(language)), { end: { stopReason: 'end_turn' } }],
    }],
    steps: [{ end: { stopReason: 'end_turn' } }],
  };
}

/** The sentence of the ordering page after a person's correction. */
export const ORDERING_CORRECTED: Record<ScriptLanguage, string> = {
  en: "Checkout asks payments to authorize the card for the order's total, and a declined payment cancels the order.",
  ru: 'При оформлении заказа сервис заказов просит сервис платежей авторизовать карту на сумму заказа, а отклонённый платёж отменяет заказ.',
};

/**
 * The refresh after a document the pages stand on changed and a person corrected a sentence of the ordering page: the
 * product page and the ordering page are edited (the ordering sentence is the corrected one); the payments page is not
 * asked for. Each unit takes `delay` milliseconds, so a walk can see the plan while the units run.
 */
export function groundRefreshScript(language: ScriptLanguage, delay = 0) {
  const t = TEXT[language];
  const wait = delay > 0 ? [{ sleep: delay }] : [];
  const ordering = domainFields(language, 'ordering', ORDERS_SERVICE, ['doc:docs/requirements.md#uc-2', PAY], ORDERING_CORRECTED[language]);
  return {
    byPrompt: [
      ...agentScript().byPrompt.filter((entry) => entry.matches.startsWith('Write the ') || entry.matches.startsWith('Judge this proposed procedure step')),
      { matches: 'You write the product page', steps: [...wait, { call: { tool: 'write_page', arguments: { markdown: productPage(language), domains: [
        { slug: 'ordering', title: t.ordering, summary: t.orderingSummary, evidence: [ORDERS_SERVICE, 'doc:docs/requirements.md#uc-1'] },
        { slug: 'payments', title: t.payments, summary: t.paymentsSummary, evidence: [PAYMENTS_SERVICE, 'doc:docs/requirements.md#uc-2'] },
      ] } } }, { end: { stopReason: 'end_turn' } }] },
      { matches: 'You write the domain page docs/domains/ordering.md', steps: [...wait, fieldsCall(ordering), { end: { stopReason: 'end_turn' } }] },
    ],
    steps: [{ end: { stopReason: 'end_turn' } }],
  };
}
