
/**
 * The editorial pass (madarch-ztyq.9; decision 0032, section 6): after a batch of pages is
 * written, read them as a newcomer would and ask for bounded revisions.
 *
 * The order is deterministic first. Everything the pass finds without a model comes from the
 * pages' own structure and the graph:
 *
 * - two pages state the same fact (their statements stand on the same ground) with the same
 *   words and different numbers;
 * - a glossary passage's own synonym stands in the prose where the term's title does not;
 * - a graph key, a file path or a code name the graph holds stands in a reader's sentence.
 *
 * Only then is the editing role asked, through a judge seam: it sees bounded excerpts of the
 * pages, the deterministic findings and the per-page bound, and it answers with page/passage
 * pairs it was shown. The pass returns findings and requests; it writes no page. The writer
 * decides how a request becomes a bounded rework of the named passage.
 *
 * Findings and accepted requests are journal entries, so a revision is never a hidden edit.
 */

/** The most revision requests one pass returns; a page's own bound is the smaller of this and `maxPerPage`. */
export const MAX_EDITORIAL_REQUESTS = 12;

/** The setting's default: the most revision requests one page may receive in a pass (madarch-ztyq.9). */
export const DEFAULT_EDITORIAL_REQUESTS_PER_PAGE = 2;
