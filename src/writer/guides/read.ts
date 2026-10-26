import { parseGuideArtifact } from './artifact.js';
import { GUIDE_OUTPUTS } from './host-contract.js';
import type { GuideHost } from './host.js';
import type { GuideDiagnostic, GuideDocument, GuideKind, GuideLocale } from './model.js';
import { guideWalkStatus, type GuideWalkResult } from './receipts.js';
import { renderGuideBodyMarkdown } from './render.js';
import { byCodePoint } from '../../model/order.js';
import { sourceAddress } from '../../knowledge/resolve.js';
import { LineCounter, parseDocument } from 'yaml';
import { lineForPath } from '../../model/yaml-position.js';

export interface GuidePageData {
  readonly guide: GuideDocument;
  readonly walk: GuideWalkResult;
  readonly markdown: string;
  readonly diagnostics: readonly GuideDiagnostic[];
  readonly coverage: 'procedures' | 'gap-only';
  readonly sourceViewWarning?: string;
  readonly grounds: readonly { readonly procedure: string; readonly step: string; readonly repository: string; readonly commit: string; readonly path: string; readonly line: number; readonly endLine: number; readonly href: string }[];
}
export type GuidePageRead =
  | { readonly ok: true; readonly data: GuidePageData; readonly diagnostics: readonly GuideDiagnostic[] }
  | { readonly ok: false; readonly diagnostics: readonly GuideDiagnostic[] };

/** One fresh checked assembly feeds every format. No execution occurs here. */
export async function readGuidePage(input: { file: string; source: string; kind: GuideKind; locale?: GuideLocale; host: GuideHost }): Promise<GuidePageRead> {
  const checked = await parseGuideArtifact(input.file, input.source, input.host.validation);
  if (!checked.ok) return input.locale !== 'ru' ? checked : { ok: false, diagnostics: checked.diagnostics.map((diagnostic) => ({ ...diagnostic, message: `${diagnostic.file}:${diagnostic.line}: ${diagnostic.path}: руководство не прошло проверку (${diagnostic.code})` })) };
  const guide = checked.guide;
  if (guide.id !== GUIDE_OUTPUTS[input.kind].id || guide.kind !== input.kind) return { ok: false, diagnostics: [{ file: input.file, line: 2, path: '$.id', code: 'guide-identity', message: `${input.file}:2: $.id: guide identity differs from its registered output` }] };
  const diagnostics: GuideDiagnostic[] = [];
  if (guide.procedures.length === 0) {
    const end = input.source.indexOf('\n---\n', 4);
    const lines = new LineCounter();
    const document = parseDocument(input.source.slice(4, end), { lineCounter: lines, keepSourceTokens: true });
    const line = lineForPath(document, lines, ['guide', 'procedures']) + 1;
    diagnostics.push({ file: input.file, line, path: '$.guide.procedures', code: 'guide-gap-only', message: `${input.file}:${line}: $.guide.procedures: ${guide.locale === 'ru' ? 'Подтверждённых процедур пока нет; пробелы не означают завершённое руководство' : 'No source-verified procedures are available; stated gaps do not mean a completed guide'}` });
  }
  let receipts: readonly unknown[] = [];
  let locations: Awaited<ReturnType<GuideHost['readReceipts']>>['locations'];
  try {
    const read = await input.host.readReceipts();
    diagnostics.push(...read.diagnostics);
    locations = read.locations;
    if (read.diagnostics.length === 0) receipts = read.receipts;
  } catch {
    diagnostics.push({ file: input.file, line: 1, path: '$.receipts', code: 'receipt-read', message: `${input.file}:1: $.receipts: execution evidence is unavailable` });
  }
  const walk = await guideWalkStatus(guide, receipts, input.host.execution);
  for (const diagnostic of walk.diagnostics) {
    const prefix = '$.receipts[';
    const close = diagnostic.path.indexOf(']', prefix.length);
    const index = diagnostic.path.startsWith(prefix) && close >= 0 ? Number(diagnostic.path.slice(prefix.length, close)) : -1;
    const location = Number.isInteger(index) && index >= 0 ? locations?.[index] : undefined;
    if (location === undefined) { diagnostics.push(diagnostic); continue; }
    const field = diagnostic.path.slice(close + 1);
    const segments = field.startsWith('.') ? [field.slice(1)] : [];
    const line = location.lineAt(segments);
    const path = field === '' ? '$' : `$${field}`;
    diagnostics.push({ ...diagnostic, file: location.file, line, path, message: `${location.file}:${line}: ${path}: execution evidence was not accepted / свидетельство исполнения не принято (${diagnostic.code})` });
  }
  if (guide.locale === 'ru') for (let index = 0; index < diagnostics.length; index += 1) {
    const diagnostic = diagnostics[index]!;
    diagnostics[index] = { ...diagnostic, message: `${diagnostic.file}:${diagnostic.line}: ${diagnostic.path}: проверка свидетельства прохождения не завершена (${diagnostic.code})` };
  }
  diagnostics.sort((a, b) => byCodePoint(a.file, b.file) || a.line - b.line || byCodePoint(a.path, b.path) || byCodePoint(a.code, b.code));
  const literal = (text: string): string => [...text].map((character) => character === '&' ? '&amp;' : character === '<' ? '&lt;' : character === '>' ? '&gt;' : '\\`*_{}[]()#+.!|~-'.includes(character) ? `\\${character}` : character === '\n' || character === '\r' ? ' ' : character).join('');
  const grounds = guide.procedures.flatMap((procedure) => procedure.steps.flatMap((step) => step.grounds.map((ground) => ({ ...ground, procedure: procedure.id, step: step.id, href: sourceAddress(ground.repository === input.host.productRepositoryId ? null : ground.repository, ground.path, ground.line) }))));
  const sourceViewWarning = grounds.some((ground) => ground.repository === input.host.productRepositoryId)
    ? guide.locale === 'ru' ? 'Ссылка на документ продукта открывает текущий файл, а не неизменяемый снимок. Указанная ревизия сохранена в подписи; перед действием проверьте источник снова.' : 'A product document link opens the current file, not an immutable snapshot. The cited revision stays in its label; revalidate the source before acting.'
    : undefined;
  const sourceNotice = sourceViewWarning === undefined ? '' : `\n${literal(sourceViewWarning)}\n`;
  const notes = diagnostics.length === 0 ? '' : `\n## ${guide.locale === 'ru' ? 'Проверка прохождения' : 'Walkthrough evidence'}\n\n${diagnostics.map((diagnostic) => `- ${literal(diagnostic.message)}`).join('\n')}\n`;
  return { ok: true, data: { guide, walk, markdown: renderGuideBodyMarkdown(guide, walk, { groundHref: (ground) => sourceAddress(ground.repository === input.host.productRepositoryId ? null : ground.repository, ground.path, ground.line) }) + sourceNotice + notes, diagnostics, grounds, ...(sourceViewWarning === undefined ? {} : { sourceViewWarning }), coverage: guide.procedures.length === 0 ? 'gap-only' : 'procedures' }, diagnostics };
}

/** A guide-only projection, not a second broad PageModel serializer. */
export function guidePageMarkdown(page: { blocks: readonly { type: string; data?: unknown }[] }): { ok: true; markdown: string } | { ok: false; message: string } {
  if (page.blocks.length !== 1 || page.blocks[0]?.type !== 'guide') return { ok: false, message: 'the Markdown projection requires exactly one checked guide block; no other blocks were omitted / Markdown требует ровно один проверенный блок руководства; другие блоки не пропущены' };
  const data = page.blocks[0].data as GuidePageData | undefined;
  if (data === undefined || typeof data.markdown !== 'string' || !Array.isArray(data.diagnostics)) return { ok: false, message: 'the checked guide block has no Markdown projection / у проверенного блока руководства нет Markdown-представления' };
  return { ok: true, markdown: data.markdown };

}
