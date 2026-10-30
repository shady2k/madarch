/**
 * The role-based judging step on top of the answer-key packs (madarch-j6ho.2).
 *
 * A judge reads one evidence pack and answers one of the four classes above,
 * with a one-line reason and the ids of the passages in that pack it used. It
 * never writes page text into the answer: a passage id outside the pack is
 * refused.
 *
 * A host may pass a jev judge (the older reader). When it does, jev reads every
 * unsure pack and its remaining `unsure` answers go to a person; no model role
 * is started. Without jev, `classification` reads every unsure pack, only its
 * `unsure` answers go to `analysis`, and a pack both leave `unsure` goes to a
 * person. An unassigned role uses the default pair (`writing`) with a note. With
 * no jev, no assigned role and no default pair, nothing is judged and the report
 * says where to assign the roles.
 */
import type { AnswerKeyCheck, AnswerKeyCounts, AnswerKeyPack, Classification } from './answer-key-check.js';
import { roleOf, type ModelPair, type ModelRole, type ModelRoleView, type ModelRoleSource } from './model-roles.js';

export interface JudgeAnswer {
  readonly verdict: Classification;
  /** One line; newlines are folded to spaces. */
  readonly reason: string;
  /** Ids of passages in this pack only. */
  readonly passages: readonly string[];
}

/** One evidence pack in, one answer out. A judge holds no other state the step relies on. */
export interface Judge {
  judge(pack: AnswerKeyPack): Promise<JudgeAnswer> | JudgeAnswer;
  /** What the judge saw while it ran (a saved model the agent no longer offers, say); reported, never dropped. */
  warnings?(): readonly string[];
  close?(): Promise<void>;
}

/** The judge could not run at all (the agent did not start, its run was stopped, or it gave no answer): the pack is
 * unjudged, not unsure, because nothing was read (madarch-j6ho.2, the review's third rare finding). */
export class JudgeExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JudgeExecutionError';
  }
}

export type JudgeTier = 'jev' | 'classification' | 'analysis';

export interface JudgeTierCounts {
  readonly read: number;
  readonly fully: number;
  readonly partly: number;
  readonly none: number;
  readonly unsure: number;
}

export interface JudgeVerdict {
  readonly itemId: string;
  readonly tier: JudgeTier;
  readonly verdict: Classification;
  readonly reason: string;
  readonly passages: readonly string[];
}

export interface JudgeRoleNote {
  readonly role: ModelRole;
  readonly source: ModelRoleSource;
  readonly note?: string;
}

export interface JudgeReport {
  readonly status: 'judged' | 'unjudged';
  readonly jevUsed: boolean;
  readonly tiers: {
    readonly jev: JudgeTierCounts | null;
    readonly classification: JudgeTierCounts;
    readonly analysis: JudgeTierCounts;
  };
  readonly verdicts: readonly JudgeVerdict[];
  /** Packs that stayed unsure in the last tier that read them, or after jev. */
  readonly person: readonly { readonly itemId: string; readonly reason: string }[];
  /** Packs no judge read, with the reason (normally a missing role and no default pair). */
  readonly unjudged: readonly { readonly itemId: string; readonly reason: string }[];
  readonly roles: readonly JudgeRoleNote[];
  readonly notes: readonly string[];
  /** Lines a judge reported about its own run, such as a saved model the agent no longer offers. */
  readonly warnings: readonly string[];
  readonly whereToAssign: string;
}

export interface JudgeDependencies {
  /** The host's older reader, when it has one. */
  readonly jev?: Judge;
  readonly roles: ModelRoleView;
  /** Makes the judge for a resolved role. Features ask for a role; only this seam sees the pair. */
  readonly judgeForPair: (pair: ModelPair, role: ModelRole) => Judge;
}

const EMPTY_TIER: JudgeTierCounts = { read: 0, fully: 0, partly: 0, none: 0, unsure: 0 };

function tierCounts(verdicts: readonly JudgeVerdict[], tier: JudgeTier): JudgeTierCounts {
  const found = verdicts.filter((verdict) => verdict.tier === tier);
  return {
    read: found.length,
    fully: found.filter((verdict) => verdict.verdict === 'fully').length,
    partly: found.filter((verdict) => verdict.verdict === 'partly').length,
    none: found.filter((verdict) => verdict.verdict === 'none').length,
    unsure: found.filter((verdict) => verdict.verdict === 'unsure').length,
  };
}

function oneLine(reason: string): string {
  return reason.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/**
 * Checks one answer against the pack. The verdict must be one of the four
 * classes, the reason must say something on one line, and every passage id must
 * be in this pack. Throws a message naming the item; the caller turns it into
 * an `unsure` answer rather than accepting invented evidence.
 */
export function validateJudgeAnswer(pack: AnswerKeyPack, answer: JudgeAnswer): JudgeAnswer {
  const at = `src/knowledge/answer-key-judge.ts: item ${pack.item.id}`;
  if (!['fully', 'partly', 'none', 'unsure'].includes(answer.verdict)) throw new Error(`${at}: a judge answered ${JSON.stringify(answer.verdict)}; the classes are fully, partly, none and unsure`);
  const reason = oneLine(answer.reason);
  if (reason === '') throw new Error(`${at}: a judge gave no reason`);
  if (!Array.isArray(answer.passages)) throw new Error(`${at}: a judge gave no passage list`);
  const ids = new Set(pack.passages.map((passage) => passage.id));
  const outside = answer.passages.filter((id) => !ids.has(id));
  if (outside.length > 0) throw new Error(`${at}: a judge cited ${outside.map((id) => JSON.stringify(id)).join(', ')}, which ${outside.length === 1 ? 'is' : 'are'} not ${outside.length === 1 ? 'a passage' : 'passages'} in this pack; the pack has ${ids.size} passage ids`);
  if ((answer.verdict === 'fully' || answer.verdict === 'partly') && answer.passages.length === 0) throw new Error(`${at}: a judge answered ${answer.verdict} without citing a passage; ${answer.verdict} names the evidence it used, while none and unsure may cite none`);
  return { verdict: answer.verdict, reason, passages: [...answer.passages] };
}

/** A pack a judge could not read at all: the run failed before it could answer, so the pack is unjudged. */
interface JudgeFailure {
  readonly itemId: string;
  readonly tier: JudgeTier;
  readonly reason: string;
}

function isVerdict(one: JudgeVerdict | JudgeFailure): one is JudgeVerdict {
  return 'verdict' in one;
}

async function answerOne(judge: Judge, pack: AnswerKeyPack, tier: JudgeTier): Promise<JudgeVerdict | JudgeFailure> {
  try {
    const answer = validateJudgeAnswer(pack, await judge.judge(pack));
    return { itemId: pack.item.id, tier, ...answer };
  } catch (error) {
    const message = oneLine(error instanceof Error ? error.message : String(error));
    // A judge that could not run says nothing about the pack, so it is unjudged; a judge that ran and answered
    // badly is a reading that failed, which is unsure (madarch-j6ho.2, the review's third rare finding).
    if (error instanceof JudgeExecutionError) return { itemId: pack.item.id, tier, reason: message };
    return { itemId: pack.item.id, tier, verdict: 'unsure', reason: `judge failed: ${message}`, passages: [] };
  }
}

function namesOfRole(view: ModelRoleView, role: ModelRole): JudgeRoleNote {
  const found = roleOf(view, role);
  return {
    role,
    source: found.source,
    ...(found.note === undefined ? {} : { note: found.note }),
  };
}

function pairOf(view: ModelRoleView, role: ModelRole): ModelPair | null {
  return roleOf(view, role).pair;
}

/** The counts of a set of packs after judging, in the check's own order. */
export function countsOfPacks(items: readonly AnswerKeyPack[]): AnswerKeyCounts {
  return {
    fully: items.filter((item) => item.classification === 'fully').length,
    partly: items.filter((item) => item.classification === 'partly').length,
    none: items.filter((item) => item.classification === 'none').length,
    unsure: items.filter((item) => item.classification === 'unsure').length,
  };
}

/**
 * Judges the check's unsure packs and returns a check with the answers applied,
 * plus the report. No role is resolved to a model name here: a role is asked
 * for, and `judgeForPair` decides how that pair is started.
 */
export async function judgeAnswerKeyCheck(check: AnswerKeyCheck, deps: JudgeDependencies): Promise<AnswerKeyCheck> {
  const packs = check.items.filter((item) => item.classification === 'unsure');
  const verdicts: JudgeVerdict[] = [];
  const failures: JudgeFailure[] = [];
  const notes: string[] = [];
  const warnings: string[] = [];
  const judges: Judge[] = [];
  const unsureReason = new Map<string, string>();
  let person: { itemId: string; reason: string }[] = [];
  let jevUsed = false;

  try {
    if (packs.length === 0) {
      notes.push('there were no unsure packs to judge');
    } else {
      // The owner's chain: jev, then classification, then analysis, then a person (madarch-j6ho.2, finding 4).
      let remaining: AnswerKeyPack[] = [...packs];
      if (deps.jev !== undefined) {
        jevUsed = true;
        judges.push(deps.jev);
        const next: AnswerKeyPack[] = [];
        for (const pack of packs) {
          const one = await answerOne(deps.jev, pack, 'jev');
          if (isVerdict(one)) {
            verdicts.push(one);
            if (one.verdict === 'unsure') { unsureReason.set(one.itemId, one.reason); next.push(pack); }
          } else failures.push(one);
        }
        remaining = next;
        notes.push('jev read every unsure pack; the packs it left unsure go on to the model roles, and a person reads what they leave unsure');
      }
      for (const tier of ['classification', 'analysis'] as const) {
        if (remaining.length === 0) break;
        const pair = pairOf(deps.roles, tier);
        if (pair === null) {
          const because = `no ${tier} role is assigned and there is no default pair (writing) to fall back to`;
          if (jevUsed) {
            notes.push(`${because}; the packs jev left unsure reached a person`);
            break;
          }
          for (const pack of remaining) failures.push({ itemId: pack.item.id, tier, reason: because });
          remaining = [];
          notes.push(`nothing was judged: ${because}`);
          notes.push('assign Classification and Analysis in the product settings, section Model roles');
          break;
        }
        const roleNote = namesOfRole(deps.roles, tier);
        if (roleNote.note !== undefined) notes.push(roleNote.note);
        const judge = deps.judgeForPair(pair, tier);
        judges.push(judge);
        const next: AnswerKeyPack[] = [];
        for (const pack of remaining) {
          const one = await answerOne(judge, pack, tier);
          if (isVerdict(one)) {
            verdicts.push(one);
            if (one.verdict === 'unsure') { unsureReason.set(one.itemId, one.reason); next.push(pack); }
          } else failures.push(one);
        }
        remaining = next;
      }
      const failed = new Set(failures.map((failure) => failure.itemId));
      person = remaining
        .filter((pack) => !failed.has(pack.item.id))
        .map((pack) => ({ itemId: pack.item.id, reason: unsureReason.get(pack.item.id) ?? 'no judge read it' }));
    }
  } finally {
    for (const judge of judges) {
      for (const line of judge.warnings?.() ?? []) if (!warnings.includes(line)) warnings.push(line);
      await judge.close?.().catch(() => undefined);
    }
  }

  // Nothing was read at all: the judging did not happen, which is not the same answer as unsure.
  const status: 'judged' | 'unjudged' = packs.length > 0 && verdicts.length === 0 ? 'unjudged' : 'judged';

  const winning = new Map<string, JudgeVerdict>();
  for (const verdict of verdicts) if (verdict.verdict !== 'unsure') winning.set(verdict.itemId, verdict);
  const items: AnswerKeyPack[] = check.items.map((pack) => {
    const verdict = winning.get(pack.item.id);
    if (verdict === undefined) return pack;
    return {
      ...pack,
      classification: verdict.verdict,
      reason: `judged by ${verdict.tier}: ${verdict.reason}`,
      judgedBy: verdict.tier,
      judgeReason: verdict.reason,
      judgePassages: verdict.passages,
    };
  });
  const counts = countsOfPacks(items);
  const fullyRatio = items.length === 0 ? 0 : counts.fully / items.length;
  const thresholdMet = fullyRatio >= check.threshold.fullyAtLeast
    && counts.none <= check.threshold.noneAtMost
    && check.questions.expected.length === check.threshold.expectedQuestions
    && check.questions.matched === check.threshold.expectedQuestions
    && check.seam.mainKeyOpenItems === check.questions.expected.length
    && check.seam.problems.length === 0;

  const tier = (name: JudgeTier): JudgeTierCounts => tierCounts(verdicts, name);
  const jevTier = jevUsed ? tier('jev') : null;
  const roleNotes: JudgeRoleNote[] = [namesOfRole(deps.roles, 'writing'), namesOfRole(deps.roles, 'classification'), namesOfRole(deps.roles, 'analysis')];
  const unjudged = failures.map((failure) => ({ itemId: failure.itemId, reason: failure.reason }));
  const judge: JudgeReport = {
    status,
    jevUsed,
    tiers: { jev: jevTier, classification: tier('classification'), analysis: tier('analysis') },
    verdicts,
    person,
    unjudged,
    roles: roleNotes,
    notes,
    warnings,
    whereToAssign: 'the product settings page, section Model roles (/k/settings)',
  };

  return { ...check, counts, fullyRatio, thresholdMet, items, judge };
}

/** One line per tier, plus the person count, for the terminal and the report. */
export function judgeLines(check: AnswerKeyCheck): string[] {
  const report = check.judge;
  if (report === undefined) return [];
  const lines: string[] = [];
  if (report.status === 'unjudged') lines.push(`judging: nothing judged; ${report.unjudged.length} packs are unjudged`);
  else if (report.jevUsed) lines.push('judging: jev read the unsure packs; no model role was started');
  else if (report.verdicts.length === 0) lines.push('judging: there were no unsure packs to judge');
  else lines.push('judging: classification then analysis');
  for (const name of ['jev', 'classification', 'analysis'] as const) {
    const tier = name === 'jev' ? report.tiers.jev : report.tiers[name];
    if (tier === null) continue;
    lines.push(`judging ${name}: read ${tier.read}; fully ${tier.fully}, partly ${tier.partly}, none ${tier.none}, unsure ${tier.unsure}`);
  }
  lines.push(`judging: ${report.person.length} packs reached a person; ${report.unjudged.length} were unjudged`);
  for (const note of report.notes) lines.push(`judging note: ${note}`);
  for (const warning of report.warnings) lines.push(`judging warning: ${warning}`);
  return lines;
}
