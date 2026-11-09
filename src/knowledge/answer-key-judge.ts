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

/** The judge could not run at all (the agent did not start, its run was stopped, or it gave no answer): the pack is
 * unjudged, not unsure, because nothing was read (madarch-j6ho.2, the review's third rare finding). */
export class JudgeExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JudgeExecutionError';
  }
}



/**
 * Checks one answer against the pack. The verdict must be one of the four
 * classes, the reason must say something on one line, and every passage id must
 * be in this pack. Throws a message naming the item; the caller turns it into
 * an `unsure` answer rather than accepting invented evidence.
 */
