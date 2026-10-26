import { byCodePoint } from '../../model/order.js';
import { guideDigest, guideStepDigest, sameGuideContext } from './digest.js';
import { GUIDE_RECEIPT_SCHEMA, type GuideDiagnostic, type GuideDocument, type GuideProcedure, type GuideReceipt, type GuideStep, type GuideWalkStatus } from './model.js';
import { isCheckedGuide, safeGuidePath } from './validate.js';

// Process-local result integrity only. Reloads must read and verify durable evidence again.
const verifiedWalks = new WeakMap<object, GuideDocument>();
export function isGuideWalkResult(result: GuideWalkResult, guide: GuideDocument): boolean { return verifiedWalks.get(result) === guide; }

/** Authentication and observed-result matching are different facts. */
export type GuideExecutionVerification =
  | { readonly kind: 'unverified'; readonly reason: string }
  | { readonly kind: 'verified'; readonly observationMatches: boolean };

/** Host capability. Its evidence reader is never exposed through an agent tool. */
export interface GuideWalkHost {
  readonly file: string;
  readonly locale?: 'en' | 'ru';
  containsSecret(text: string): boolean;
  /** Independently retained operator evidence must match command/input digests, environment,
   * prerequisites, actual status and observed result. Author strings are not credentials. */
  verifyExecution(receipt: GuideReceipt, step: GuideStep, procedure: GuideProcedure, guide: GuideDocument): Promise<GuideExecutionVerification>;
}
export interface GuideWalkResult {
  readonly guide: string;
  readonly status: GuideWalkStatus;
  readonly steps: readonly { readonly procedure: string; readonly step: string; readonly status: GuideWalkStatus }[];
  readonly diagnostics: readonly GuideDiagnostic[];
}

/** Evaluate only receipts independently confirmed by the host, never an agent's passed flag. */
export async function guideWalkStatus(guide: GuideDocument, receipts: readonly unknown[], host: GuideWalkHost): Promise<GuideWalkResult> {
  const diagnostics: GuideDiagnostic[] = [];
  const error = (path: string, code: string, message: string): void => { diagnostics.push({ file: host.file, line: 1, path, code, message: `${host.file}:1: ${path}: ${message}` }); };
  const rows: { procedure: string; step: string; status: GuideWalkStatus }[] = [];
  if (!isCheckedGuide(guide)) error('$', 'unchecked-guide', 'guide has not passed host source verification');
  if (!Array.isArray(receipts) || receipts.length > 2400) error('$.receipts', 'bound', 'expected at most 2400 receipts');
  if (typeof host.verifyExecution !== 'function' || typeof host.containsSecret !== 'function') error('$.receipts', 'verification-unavailable', 'independent execution verification is unavailable');
  if (diagnostics.length > 0) return { guide: guide.id, status: 'not-walked', steps: [], diagnostics };
  try { if (new TextEncoder().encode(JSON.stringify(receipts)).length > 1024 * 1024) { error('$.receipts', 'bound', 'receipt set exceeds 1048576 bytes'); return { guide: guide.id, status: 'not-walked', steps: [], diagnostics }; } }
  catch { error('$.receipts', 'receipt-data', 'receipt set is not serializable'); return { guide: guide.id, status: 'not-walked', steps: [], diagnostics }; }
  const allowed = ['schema', 'guide', 'procedure', 'step', 'context', 'unitVersion', 'inputDigest', 'commandDigest', 'environment', 'prerequisitesDigest', 'cwd', 'at', 'evidence', 'actualStatus', 'observed'];
  const candidates: { receipt: GuideReceipt; index: number }[] = [];
  for (const [index, value] of receipts.entries()) {
    const path = `$.receipts[${index}]`;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) { error(path, 'receipt', 'expected an execution receipt'); continue; }
    let serialized: string;
    try { serialized = JSON.stringify(value); } catch { error(path, 'receipt-data', 'receipt is not serializable'); continue; }
    if (new TextEncoder().encode(serialized).length > 32768) { error(path, 'bound', 'receipt exceeds 32768 bytes'); continue; }
    const r = JSON.parse(serialized) as Record<string, unknown>;
    if (Object.keys(r).some((key) => !allowed.includes(key)) || allowed.some((key) => !(key in r))) { error(path, 'receipt-fields', 'receipt fields are incomplete or unknown; self-attestation is not evidence'); continue; }
    if (r['schema'] !== GUIDE_RECEIPT_SCHEMA || typeof r['guide'] !== 'string' || typeof r['procedure'] !== 'string' || typeof r['step'] !== 'string' || typeof r['context'] !== 'object' || r['context'] === null) { error(path, 'receipt-schema', 'receipt identity or context is invalid'); continue; }
    const stringFields = ['unitVersion', 'inputDigest', 'commandDigest', 'environment', 'prerequisitesDigest', 'cwd', 'at', 'evidence', 'observed'];
    if (stringFields.some((key) => typeof r[key] !== 'string' || (r[key] as string).trim() === '' || (r[key] as string).length > 16000)) { error(path, 'receipt-text', 'receipt text must be non-blank and bounded'); continue; }
    if (typeof r['actualStatus'] !== 'number' || !Number.isInteger(r['actualStatus'])) { error(`${path}.actualStatus`, 'receipt-status', 'actual status must be an integer'); continue; }
    if (!Number.isFinite(Date.parse(String(r['at']))) || !String(r['at']).endsWith('Z')) { error(`${path}.at`, 'receipt-time', 'execution time must be a UTC instant'); continue; }
    if (!safeGuidePath(String(r['evidence']))) { error(`${path}.evidence`, 'receipt-path', 'evidence must be a safe product-relative path'); continue; }
    try { if (host.containsSecret(JSON.stringify(r))) { error(path, 'secret', 'receipt contains a sensitive value'); continue; } }
    catch { error(path, 'verification-unavailable', 'secret verification failed'); continue; }
    candidates.push({ receipt: r as unknown as GuideReceipt, index });
  }
  for (const procedure of guide.procedures) for (const step of procedure.steps) {
    const matches = candidates.filter(({ receipt }) => receipt.guide === guide.id && receipt.procedure === procedure.id && receipt.step === step.id);
    let status: GuideWalkStatus = 'not-walked';
    if (matches.length > 1) error(`$.${procedure.id}.${step.id}`, 'duplicate-receipt', 'multiple receipts are ambiguous; select one actual execution');
    else if (matches.length === 1) {
      const { receipt, index } = matches[0]!;
      const path = `$.receipts[${index}]`;
      let contextMatches = false;
      try { contextMatches = sameGuideContext(receipt.context, guide.context); } catch { /* Invalid context is not a match. */ }
      const prerequisitesDigest = guideDigest({ guide: guide.prerequisites, procedure: procedure.prerequisites });
      if (!contextMatches || receipt.unitVersion !== guide.unitVersion || receipt.inputDigest !== guide.inputDigest || receipt.commandDigest !== guideStepDigest(guide, procedure.id, step) || receipt.cwd !== step.cwd || receipt.environment !== step.environment || receipt.prerequisitesDigest !== prerequisitesDigest) error(path, 'stale-receipt', 'receipt does not match the exact checked command, input, prerequisites and context');
      else {
        try {
          const verification = await host.verifyExecution(receipt, step, procedure, guide);
          if (verification?.kind === 'verified' && typeof verification.observationMatches === 'boolean') {
            status = receipt.actualStatus === step.expected.status && verification.observationMatches ? 'passed' : 'failed';
          } else error(path, 'unverified-execution', 'independent evidence did not authenticate the execution');
        } catch { error(path, 'verification-unavailable', 'independent execution evidence could not be checked'); }
      }
    }
    rows.push({ procedure: procedure.id, step: step.id, status });
  }
  for (const { receipt, index } of candidates) if (!guide.procedures.some((p) => p.id === receipt.procedure && p.steps.some((s) => s.id === receipt.step)) || receipt.guide !== guide.id) error(`$.receipts[${index}]`, 'unknown-step', 'receipt does not name a step in this guide');
  diagnostics.sort((a, b) => byCodePoint(a.path, b.path) || byCodePoint(a.code, b.code));
  const status = rows.some((row) => row.status === 'failed') ? 'failed' : diagnostics.length === 0 && rows.length > 0 && rows.every((row) => row.status === 'passed') ? 'passed' : 'not-walked';
  const result: GuideWalkResult = Object.freeze({ guide: guide.id, status, steps: Object.freeze(rows.map((row) => Object.freeze(row))), diagnostics: Object.freeze(diagnostics.map((diagnostic) => Object.freeze(diagnostic))) });
  verifiedWalks.set(result, guide);
  return result;
}
