/**
 * The ids of the loop's own files (madarch-ztyq.12): a new question, a
 * correction, a task or a question-file footnote is named by the first 12 hex
 * characters of SHA-256 over its canonical content. A person reads the title;
 * an id only has to be unique and stable. Existing files keep their names and
 * are found by the id stored in them or by their file name.
 */

/**
 * A question id as the wiki reads it back: an old lower-case name from a file
 * written before content hashes, or a content hash and its collision suffix.
 */
export const QUESTION_SLUG = /^(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*|[0-9a-f]{12}(?:-[0-9]+)?)$/;
