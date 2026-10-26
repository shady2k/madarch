/** Safe guide preparation diagnostics. Exception text never enters a reader-facing refusal. */
export const GUIDE_PREPARATION_STAGES = ['registry', 'preparation', 'context', 'source-membership', 'graph-membership', 'source-evidence', 'source-policy', 'publication-owner', 'context-packets', 'current-proof', 'unit'] as const;
export type GuidePreparationStage = typeof GUIDE_PREPARATION_STAGES[number];
export const GUIDE_PREPARATION_CODES = ['unavailable', 'invalid', 'changed', 'bound', 'incompatible', 'unsupported', 'failed'] as const;
export type GuidePreparationCode = typeof GUIDE_PREPARATION_CODES[number];
export const GUIDE_PREPARATION_FILES = ['src/writer/guides/writer.ts', 'src/writer/guides/publication.ts', 'src/writer/guides/prepared.ts', 'src/writer/guides/host-contract.ts', 'src/writer/run.ts'] as const;
export type GuidePreparationFile = typeof GUIDE_PREPARATION_FILES[number];
export interface GuidePreparationDetail {
  readonly stage: GuidePreparationStage;
  readonly code: GuidePreparationCode;
  /** Engine-owned coordinate only, never an authored source path or field. */
  readonly file?: GuidePreparationFile;
  readonly line?: number;
  /** Opaque graph identity only, never a label, logical key or source value. */
  readonly fact?: string;
}
interface SafeDetail {
  readonly stage: GuidePreparationStage;
  readonly code: GuidePreparationCode;
  readonly file?: GuidePreparationFile;
  readonly line: number;
  readonly fact?: string;
}
// A private brand prevents forged prototypes, mutation and exception getters from supplying diagnostics.
const details = new WeakMap<object, SafeDetail>();
function member<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && values.some((candidate) => candidate === value);
}
function graphIdentity(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 19 || value[0] === '0') return false;
  for (const character of value) if (character < '0' || character > '9') return false;
  return value.length < 19 || value <= '9223372036854775807';
}
function ownValue(input: unknown, key: string): unknown {
  if (input === null || typeof input !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}
export class GuidePreparationError extends Error {
  constructor(detail: GuidePreparationDetail) {
    super('Guide preparation failed; exception details withheld.');
    this.name = 'GuidePreparationError';
    const rawStage = ownValue(detail, 'stage'); const rawCode = ownValue(detail, 'code');
    const rawFile = ownValue(detail, 'file'); const rawLine = ownValue(detail, 'line'); const rawFact = ownValue(detail, 'fact');
    const stage = member(GUIDE_PREPARATION_STAGES, rawStage) ? rawStage : 'preparation';
    const code = member(GUIDE_PREPARATION_CODES, rawCode) ? rawCode : 'failed';
    const file = member(GUIDE_PREPARATION_FILES, rawFile) ? rawFile : undefined;
    const line = typeof rawLine === 'number' && Number.isSafeInteger(rawLine) && rawLine > 0 && rawLine <= 10_000_000 ? rawLine : 1;
    details.set(this, Object.freeze({ stage, code, ...(file === undefined ? {} : { file }), line, ...(graphIdentity(rawFact) ? { fact: rawFact } : {}) }));
  }
}
const reasonText: Record<GuidePreparationCode, string> = {
  unavailable: 'required preparation authority is unavailable; restore it and retry',
  invalid: 'required preparation data is invalid; repair the reported engine input',
  changed: 'prepared dependencies changed; refresh the complete pinned input and retry',
  bound: 'the complete input exceeds a safety bound; split the supported input rather than truncate it',
  incompatible: 'the prepared coordinates are incompatible; refresh source and graph membership together',
  unsupported: 'the required preparation operation is unsupported; use a supported source format',
  failed: 'preparation failed without a safe typed reason; inspect the reported engine phase',
};
const stageText: Record<GuidePreparationStage, string> = {
  registry: 'resolve the registered guide output', preparation: 'prepare the complete pinned guide context',
  context: 'resolve source and temporal coordinates', 'source-membership': 'validate complete pinned source membership',
  'graph-membership': 'read complete graph membership', 'source-evidence': 'prepare exact pinned source evidence',
  'source-policy': 'apply the source withholding policy', 'publication-owner': 'create the checked publication owner',
  'context-packets': 'build the complete prepared-context packets', 'current-proof': 'validate the durable current guide proof',
  unit: 'start the checked guide writer unit',
};
export interface GuidePreparationFallback {
  /** Trusted registered output path, not a path read from the caught exception. */
  readonly file: string;
  readonly stage: GuidePreparationStage;
}
export interface GuidePreparationRefusal { readonly line: number; readonly rule: 'guide-preparation'; readonly message: string }
export function formatGuidePreparationError(failure: unknown, fallback: GuidePreparationFallback): GuidePreparationRefusal {
  const held = failure !== null && typeof failure === 'object' ? details.get(failure) : undefined;
  const stage = held?.stage ?? (member(GUIDE_PREPARATION_STAGES, fallback.stage) ? fallback.stage : 'preparation');
  const code = held?.code ?? 'failed';
  const coordinate = held?.file === undefined ? '' : `; engine=${held.file}:${held.line}`;
  const fact = held?.fact === undefined ? '' : `; fact=${held.fact}`;
  return { line: 1, rule: 'guide-preparation', message: `${fallback.file}:1: $.guide: preparation refused (stage=${stage}; reason=${code}${coordinate}${fact}): could not ${stageText[stage]}; ${reasonText[code]}; nothing was certified; exception details withheld` };
}
