/**
 * What one file read answers (madarch-u3vw.16, decision 0037): the lines of a blob, and the bound that cuts a text at a size
 * the queue can carry. The plugin host's read and the queue's job share these shapes, so neither imports the other.
 */

/** The answer one job settles with: the lines' text, the whole blob's counts, and whether it is text at all. */
export interface FileTextResult {
  readonly text: string;
  readonly lines: number;
  readonly bytes: number;
  readonly binary: boolean;
  /** True when the text reaches the end of the blob; false when it was cut at `FILE_TEXT_MAX_BYTES`. */
  readonly complete: boolean;
  /** Where a cut text continues: the line, and the column inside it (1-based); null when the text is complete. */
  readonly next: { readonly line: number; readonly column: number } | null;
}

/**
 * The most bytes one read answers (the owner's review of madarch-u3vw.16): a range is a job result, and a blob that is one
 * hundred-megabyte line must not become one. A text past this is cut, and the answer names the line and the column the
 * next range continues at, so nothing is dropped silently.
 */
export const FILE_TEXT_MAX_BYTES = 256 * 1024;

/**
 * Cuts one answer at `FILE_TEXT_MAX_BYTES`: at the last whole line that fits, or inside the first line when no line break
 * fits before the bound. Answers the text kept and, for a cut, the line and the column the next range continues at — the
 * first line's column being `firstColumn` when the range starts inside a line.
 */
export function boundFileText(text: string, firstLine: number, firstColumn = 1, maxBytes = FILE_TEXT_MAX_BYTES): { text: string; complete: boolean; next: { line: number; column: number } | null } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, complete: true, next: null };
  let bytes = 0;
  let index = 0;
  let lines = 0;
  let lineStart = 0;
  while (index < text.length) {
    const character = text[index]!;
    const width = Buffer.byteLength(character, 'utf8');
    if (bytes + width > maxBytes) break;
    bytes += width;
    index += 1;
    if (character === '\n') { lines += 1; lineStart = index; }
  }
  // A whole line fits: cut after its break, and the next range starts the next line at its first column. Otherwise cut
  // inside the line, and the next range starts where this one stopped, in the same line.
  const cut = lineStart > 0 ? lineStart : index;
  const taken = text.slice(0, cut);
  return {
    text: taken,
    complete: false,
    next: lineStart > 0
      ? { line: firstLine + lines, column: 1 }
      : { line: firstLine, column: firstColumn + cut },
  };
}
