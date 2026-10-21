/**
 * Spans for the extractor schema's records (src/extract/records.ts): a source
 * span measured once per file, from the character offsets a text parser
 * reports to the byte offsets and 1-based lines the schema carries. The text
 * is read as UTF-8, so a character offset's byte offset is the length of its
 * prefix in bytes; contract files are small, and the measure is built once per
 * file.
 */
export interface SourceSpanOf {
  path: string;
  byteStart: number;
  byteEnd: number;
  lineStart: number;
  lineEnd: number;
}

/** One file's character offsets, measured against bytes and lines once. */
export class SpanMeasure {
  private readonly lineStarts: readonly number[];
  private readonly encoder = new TextEncoder();

  constructor(private readonly text: string) {
    const lines: number[] = [0];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') lines.push(i + 1);
    }
    this.lineStarts = lines;
  }

  /** The 1-based line of a character offset. */
  lineOf(charOffset: number): number {
    const offset = Math.max(0, Math.min(charOffset, this.text.length));
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (this.lineStarts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  }

  /** The byte offset of a character offset. */
  byteOf(charOffset: number): number {
    const offset = Math.max(0, Math.min(charOffset, this.text.length));
    return this.encoder.encode(this.text.slice(0, offset)).length;
  }

  /** A half-open character range [start, end) as the schema's span fields. */
  span(path: string, startChar: number, endChar: number): SourceSpanOf {
    const clampedStart = Math.max(0, Math.min(startChar, this.text.length));
    const clampedEnd = Math.max(clampedStart, Math.min(endChar, this.text.length));
    const byteStart = this.byteOf(clampedStart);
    const byteEnd = this.byteOf(clampedEnd);
    return {
      path,
      byteStart,
      byteEnd,
      lineStart: this.lineOf(clampedStart),
      lineEnd: this.lineOf(Math.max(clampedStart, clampedEnd - 1)),
    };
  }
}
