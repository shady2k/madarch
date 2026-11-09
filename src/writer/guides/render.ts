import { stringify } from 'yaml';
import type { GuideDocument, GuideGround } from './model.js';
import { isCheckedGuide } from './validate.js';
import { isGuideWalkResult, type GuideWalkResult } from './receipts.js';

const WORDS = {
  en: { prerequisites: 'Before you start', gaps: 'Known gaps', goal: 'Goal', role: 'Role', cwd: 'Working directory', environment: 'Environment', inputs: 'Required inputs', secret: 'secret input; supply locally', expected: 'Expected result', status: 'Walkthrough status', passed: 'Passed', failed: 'Failed', 'not-walked': 'Not walked', grounds: 'Source grounds', noExecution: 'Commands and requests are shown as text. Nothing runs from this page.' },
  ru: { prerequisites: 'Перед началом', gaps: 'Известные пробелы', goal: 'Цель', role: 'Роль', cwd: 'Рабочая папка', environment: 'Среда', inputs: 'Необходимые входные данные', secret: 'секрет; укажите локально', expected: 'Ожидаемый результат', status: 'Статус прохождения', passed: 'Пройдено', failed: 'Ошибка', 'not-walked': 'Не пройдено', grounds: 'Основания в исходном коде', noExecution: 'Команды и запросы показаны как текст. Эта страница ничего не выполняет.' },
} as const;
/** Render authored prose as literal Markdown text, never HTML or unvalidated links. */
const prose = (value: string): string => {
  let escaped = '';
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (character === '&') escaped += '&amp;';
    else if (character === '<') escaped += '&lt;';
    else if (character === '>') escaped += '&gt;';
    else if (character === '\n') escaped += ' ';
    else if (character === '\r' && value[index + 1] === '\n') { escaped += ' '; index++; }
    else escaped += '\\`*_{}[]()#+.!|~-'.includes(character) ? `\\${character}` : character;
  }
  return escaped;
};
const literal = (value: string): string => {
  let longest = 2;
  let run = 0;
  for (const character of value) {
    run = character === '`' ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${value}\n${fence}`;
};

export interface GuideRenderOptions {
  /** Host-owned navigation only; authored artifact fields never supply a URL. */
  readonly groundHref?: (ground: GuideGround) => string | undefined;
}
const groundLink = (ground: GuideGround, options?: GuideRenderOptions): string => {
  const label = prose(`${ground.repository}@${ground.commit}:${ground.path}:${ground.line}–${ground.endLine}`);
  if (options?.groundHref === undefined) return label;
  const href = options.groundHref(ground);
  if (href === undefined) return label;
  if (!href.startsWith('/k/src?')) throw new Error('src/writer/guides/render.ts:1: $.grounds: host source link must be a safe encoded relative URL');
  for (const character of href) {
    const code = character.charCodeAt(0);
    if (code <= 32 || code >= 127 || '\\[]()<>'.includes(character)) throw new Error('src/writer/guides/render.ts:1: $.grounds: host source link must be a safe encoded relative URL');
  }
  return `[${label}](${href})`;
};

/** Only a host-checked immutable artifact may render; arbitrary JSON cannot claim walked. */
export function renderGuideMarkdown(guide: GuideDocument, walk?: GuideWalkResult, options?: GuideRenderOptions): string {
  if (!isCheckedGuide(guide)) throw new Error('src/writer/guides/render.ts:1: $.guide: source verification is required before rendering');
  if (walk !== undefined && !isGuideWalkResult(walk, guide)) throw new Error('src/writer/guides/render.ts:1: $.walk: independent execution verification is required before rendering status');
  const words = WORDS[guide.locale];
  const status = walk?.status ?? 'not-walked';
  const out = ['---', stringify({ id: guide.id, kind: guide.kind, title: guide.title, producer: 'agent', schema: guide.schema, 'wiki-language': guide.locale, 'unit-version': guide.unitVersion, 'input-digest': guide.inputDigest, context: guide.context }).trimEnd(), '---', '', `# ${prose(guide.title)}`, '', words.noExecution, '', `**${words.status}: ${words[status]}**`, ''];
  const list = (title: string, items: readonly string[]): void => {
    if (items.length === 0) return;
    out.push(`## ${title}`, '', ...items.map((item) => `- ${prose(item)}`), '');
  };
  list(words.prerequisites, guide.prerequisites);
  list(words.gaps, guide.gaps);
  for (const procedure of guide.procedures) {
    out.push(`## ${prose(procedure.title)}`, '', `**${words.goal}:** ${prose(procedure.goal)}`, '', `**${words.role}:** ${prose(procedure.role)}`, '');
    list(words.prerequisites, procedure.prerequisites);
    for (const [index, step] of procedure.steps.entries()) {
      const stepStatus = walk?.steps.find((row) => row.procedure === procedure.id && row.step === step.id)?.status ?? 'not-walked';
      out.push(`### ${index + 1}. ${prose(step.title)}`, '', `**${words.status}: ${words[stepStatus]}**`, '', `**${words.cwd}:** ${prose(step.cwd)}`, '', `**${words.environment}:** ${prose(step.environment)}`, '');
      if (step.inputs.length > 0) out.push(`**${words.inputs}**`, '', ...step.inputs.map((input) => `- ${prose(input.name)}: ${prose(input.description)}${input.secret ? ` (${words.secret})` : ''}`), '');
      out.push(literal(step.instruction.content), '', `**${words.expected}:** ${step.expected.status} — ${prose(step.expected.observation)}`, '', `**${words.grounds}**`, '', ...step.grounds.map((ground) => `- ${groundLink(ground, options)}`), '');
    }
  }
  return `${out.join('\n')}\n`;
}

/** Reader body of the same canonical renderer, without generated YAML metadata. */
export function renderGuideBodyMarkdown(guide: GuideDocument, walk?: GuideWalkResult, options?: GuideRenderOptions): string {
  const rendered = renderGuideMarkdown(guide, walk, options);
  return rendered.slice(rendered.indexOf('\n---\n', 4) + 5);
}
