/** Scripted interpretation of one held neutral source fixture, never source or execution authority. */
import type { GuideContext, GuideDocument, GuideGround, GuideKind } from '../src/writer/guides/model.js';
import type { GuideContextPage } from '../src/writer/guides/prepared.js';
import { guideDigest } from '../src/writer/guides/digest.js';

export const SCRIPTED_GUIDE_PATH = 'docs/scripted-guide-check.md';
export const SCRIPTED_GUIDE_COMMAND = 'node -e "console.log(7)"';
export const SCRIPTED_GUIDE_OBSERVATION = '7';
export const SCRIPTED_GUIDE_PARAGRAPH = `Run \`${SCRIPTED_GUIDE_COMMAND}\` from the repository root in an isolated fixture environment. Expected exit status: 0. Expected output: ${SCRIPTED_GUIDE_OBSERVATION}.`;
export const SCRIPTED_GUIDE_SOURCE = `# Fixture readiness check\n\n${SCRIPTED_GUIDE_PARAGRAPH}\n`;
interface ToolResult { readonly isError: boolean; readonly answer: unknown }
export type ScriptedGuideCall = (tool: string, args: Record<string, unknown>) => Promise<ToolResult>;
interface PreparedHeader {
  readonly schema: GuideDocument['schema']; readonly id: string; readonly kind: GuideKind; readonly locale: 'en' | 'ru';
  readonly unitVersion: string; readonly inputDigest: string; readonly context: GuideContext; readonly firstCursor: string;
}
interface SourceEntry { readonly type: 'source'; readonly ground: GuideGround; readonly text: string; readonly part: string }
interface HeldJudgement { readonly guide: GuideDocument; readonly guideDigest: string; readonly procedure: GuideDocument['procedures'][number]; readonly step: GuideDocument['procedures'][number]['steps'][number]; readonly spans: readonly { ground: GuideGround; text: string; digest: string }[] }
// One fake agent serves nested proof sessions. Bind them to its exact in-flight full submission.
const pendingJudgements = new Map<string, HeldJudgement>();
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const lastPacket = (prompt: string): Record<string, unknown> => {
  const boundary = prompt.lastIndexOf('\n\n');
  const value: unknown = JSON.parse(boundary < 0 ? prompt : prompt.slice(boundary + 2));
  if (!object(value)) throw new Error('The scripted guide prompt has no structured packet.');
  return value;
};
const checkedCall = async (call: ScriptedGuideCall, tool: string, args: Record<string, unknown>): Promise<unknown> => {
  const result = await call(tool, args);
  if (result.isError) throw new Error(`The scripted guide ${tool} was refused: ${JSON.stringify(result.answer)}`);
  return result.answer;
};

/** Every packet is read through the actual tool before a complete structured artifact is submitted. */
export async function writeScriptedGuide(prompt: string, call: ScriptedGuideCall): Promise<void> {
  const header = lastPacket(prompt) as unknown as PreparedHeader;
  if (header.kind !== 'administrator-guide' && header.kind !== 'user-guide') throw new Error('The guide script received another unit kind.');
  const entries: unknown[] = [];
  let cursor: string | null = header.firstCursor;
  let index = 0;
  const seen = new Set<string>();
  while (cursor !== null) {
    if (typeof cursor !== 'string' || seen.has(cursor)) throw new Error('The guide context cursor is absent or repeated.');
    seen.add(cursor);
    const page = await checkedCall(call, 'read_prepared_context', { cursor }) as GuideContextPage;
    if (page.inputDigest !== header.inputDigest || page.index !== index || page.cursor !== cursor || page.total < 1 || !Array.isArray(page.entries)) throw new Error('The guide context packet does not match the prepared input.');
    entries.push(...page.entries);
    if (page.next === null && (!page.coverage.complete || page.coverage.seen !== page.total || index + 1 !== page.total)) throw new Error('The guide context did not finish its complete coverage.');
    cursor = page.next;
    index++;
  }
  const sources = entries.filter((entry): entry is SourceEntry => object(entry) && entry['type'] === 'source' && entry['part'] === 'whole' && entry['text'] === SCRIPTED_GUIDE_PARAGRAPH && object(entry['ground']) && entry['ground']['path'] === SCRIPTED_GUIDE_PATH);
  const gaps = entries.flatMap((entry) => object(entry) && entry['type'] === 'gap' && typeof entry['message'] === 'string' ? [entry['message']] : []);
  gaps.push(header.locale === 'ru' ? 'Этот сценарий проверяет только явно описанную команду готовности; остальные процедуры не подтверждены.' : 'This fixture establishes only its explicit readiness command; other procedures are not established.');
  if (sources.length === 0) gaps.push(header.locale === 'ru' ? 'В полном подготовленном контексте нет команды сценария с доказанным результатом; процедуры не придуманы.' : 'The complete prepared context has no fixture instruction with a proved expected result; no procedure was invented.');
  const russian = header.locale === 'ru';
  const guide: GuideDocument = { schema: header.schema, id: header.id, kind: header.kind, locale: header.locale,
    title: russian ? 'Руководство по проверке готовности' : 'Readiness guide', context: header.context,
    unitVersion: header.unitVersion, inputDigest: header.inputDigest, prerequisites: [], gaps,
    procedures: sources.length === 0 ? [] : [{ id: 'readiness', title: russian ? 'Проверить готовность' : 'Check readiness',
      goal: russian ? 'Прочитать описанный результат.' : 'Read the documented result.', role: russian ? 'Читатель' : 'Reader', prerequisites: [],
      steps: [{ id: 'read', title: russian ? 'Прочитать результат' : 'Read the result', cwd: '.', environment: 'isolated-fixture', inputs: [],
        instruction: { kind: 'command', content: SCRIPTED_GUIDE_COMMAND }, expected: { status: 0, observation: SCRIPTED_GUIDE_OBSERVATION },
        grounds: sources.map((source) => source.ground) }] }],
  };
  const identities: string[] = [];
  for (const procedure of guide.procedures) for (const step of procedure.steps) {
    const spans = sources.map(({ ground, text }) => ({ ground, text, digest: guideDigest({ ground, text }) }));
    const identity = guideDigest({ step, procedure: { id: procedure.id, prerequisites: procedure.prerequisites }, context: guide.context, spans });
    if (pendingJudgements.has(identity)) throw new Error('The fixture already has a pending judgement with this exact identity.');
    pendingJudgements.set(identity, { guide, guideDigest: guideDigest(guide), procedure, step, spans });
    identities.push(identity);
  }
  try { await checkedCall(call, 'write_guide', { guide }); }
  finally { for (const identity of identities) pendingJudgements.delete(identity); }
}

/** A deterministic fixture judgement checks both exact claims and the actual named source bytes. */
export async function verifyScriptedGuide(prompt: string, call: ScriptedGuideCall): Promise<void> {
  const packet = lastPacket(prompt);
  const held = typeof packet['identity'] === 'string' ? pendingJudgements.get(packet['identity']) : undefined;
  const completeSubmission = held !== undefined && guideDigest(held.guide) === held.guideDigest &&
    held.guide.id === `${held.guide.kind}:main` && held.guide.context.repositories.every((repository) => typeof repository.commit === 'string') &&
    guideDigest(packet['step']) === guideDigest(held.step) && guideDigest(packet['procedure']) === guideDigest({ role: held.procedure.role, goal: held.procedure.goal, prerequisites: held.procedure.prerequisites }) &&
    guideDigest(packet['spans']) === guideDigest(held.spans);
  const step = packet['step'];
  const spans = packet['spans'];
  const instruction = object(step) ? step['instruction'] : undefined;
  const expected = object(step) ? step['expected'] : undefined;
  const grounds = object(step) ? step['grounds'] : undefined;
  const completeSources = completeSubmission && Array.isArray(spans) && spans.length > 0 && Array.isArray(grounds) && grounds.length === spans.length && spans.every((span, index) => {
    if (!object(span) || span['text'] !== SCRIPTED_GUIDE_PARAGRAPH || !object(span['ground']) || !object(grounds[index])) return false;
    const ground = span['ground']; const claimed = grounds[index];
    return ground['path'] === SCRIPTED_GUIDE_PATH && ['repository', 'commit', 'path', 'line', 'endLine'].every((key) => ground[key] === claimed[key]);
  });
  const instructionSupported = completeSources && object(instruction) && instruction['kind'] === 'command' && instruction['content'] === SCRIPTED_GUIDE_COMMAND && object(step) && step['cwd'] === '.' && step['environment'] === 'isolated-fixture';
  const expectedSupported = completeSources && object(expected) && expected['status'] === 0 && expected['observation'] === SCRIPTED_GUIDE_OBSERVATION;
  await checkedCall(call, 'verify_guide_step', { identity: packet['identity'], instructionSupported, expectedSupported });
}
